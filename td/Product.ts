// Translated from Models/{Product,Price,Notification,Supplier,Warehouse}.cs
//
// Prisma maps String[] and Json columns natively (see schema.prisma), so
// `discounts` and `images` have a single representation and are written as-is.
//
// Price is still flattened, like in the C# version: the schema stores it in
// four columns (priceAmount, priceCurrency, priceMargin, priceVat) while the
// code works on a Price object. Nothing maps one to the other: setMargin()
// copies the margin to priceMargin by hand, and amount, currency and vat are
// never written back. The two already disagree: Price defaults the margin to
// 15, the schema to 20.

import { PrismaClient } from "@prisma/client";
import { DiscountRuleError, ImageRuleError, StockRuleError, SupplierRuleError } from "./errors";

const prisma = new PrismaClient();

export type Channel = "email" | "sms" | "push";
export type ProductStatus = "active" | "out_of_stock" | "deprecated";

export interface Notification {
  id: string;
  recipient: string;
  subject: string;
  body: string;
  channel: Channel;
  sentAt: Date;
  productId?: string;
}

export class Supplier {
  constructor(
    public id: string,
    public name: string,
    public email: string,
    public region: string,
  ) {}
}

export class Warehouse {
  constructor(
    public id: string,
    public name: string,
    public address: string,
    public region: string,
  ) {}
}

export class Price {
  static readonly DEFAULT_MARGIN_PERCENT = 15;
  static readonly DEFAULT_VAT_PERCENT = 20;

  amount: number;
  currency: string;
  margin: number; // percentage
  vat: number; // percentage, applied on margin only

  constructor(amount: number, currency: string) {
    this.amount = amount;
    this.currency = currency;
    this.margin = Price.DEFAULT_MARGIN_PERCENT;
    this.vat = Price.DEFAULT_VAT_PERCENT;
  }

  getResellerPrice(): number {
    const marginAmount = (this.amount * this.margin) / 100;
    const vatAmount = (marginAmount * this.vat) / 100;
    return this.amount + marginAmount + vatAmount;
  }
}

export class Product {
  static readonly MAX_ACTIVE_DISCOUNTS = 2;

  id: string;
  name: string;
  slug: string;
  price: Price;
  discounts: string[];
  images: Record<string, string>; // key = context ("thumbnail", "hero", ...), value = url
  suppliersRegions: Map<string, Supplier>; // key = region
  weight: number;
  dimensions: string;
  quantity: number;
  stock: number;
  warehouse: Warehouse | null;
  status: ProductStatus;
  createdAt: Date;
  updatedAt: Date;
  notifications: Notification[] = [];
  validUntil: Date | null = null;

  constructor(
    id: string,
    name: string,
    slug: string,
    price: Price,
    discounts: string[],
    images: Record<string, string>,
    suppliersRegions: Map<string, Supplier>,
    weight: number,
    dimensions: string,
    quantity: number,
    stock: number,
    warehouse: Warehouse | null,
  ) {
    this.id = id;
    this.name = name;
    this.slug = slug;
    this.price = price;
    this.discounts = discounts;
    this.images = images;
    this.suppliersRegions = suppliersRegions;
    this.weight = weight;
    this.dimensions = dimensions;
    this.quantity = quantity;
    this.stock = stock;
    this.warehouse = warehouse;
    this.status = "active";
    this.createdAt = new Date();
    this.updatedAt = new Date();
  }

  getDisplayLabel(): string {
    if (this.status === "deprecated") return `[DISCONTINUED] ${this.name}`;
    if (this.stock === 0) return `[OUT OF STOCK] ${this.name}`;
    return this.name;
  }

  // --- Catalog / images / discounts ---

  async addImage(context: string, url: string): Promise<void> {
    if (!url) throw new ImageRuleError("url is required");
    if (!Product.isHttpUrl(url)) throw new ImageRuleError(`url must start with http:// or https:// (got "${url}")`);

    const key = this.images[context] === undefined ? context : this.keyForNewVersion(context);
    this.images[key] = url;
    this.updatedAt = new Date();
    await prisma.product.update({
      where: { id: this.id },
      data: { images: this.images, updatedAt: this.updatedAt },
    });
  }

  // Policy: an image already exists for this context, so the new one is kept
  // next to it, under "<context>-<name of the FIRST supplier assigned to the
  // product>". Only the supplier's name is used, so only the name matters: a
  // supplier without region or email, or with a malformed email, is treated
  // like any other. Without any supplier, the existing image is replaced.
  private keyForNewVersion(context: string): string {
    if (this.suppliersRegions.size === 0) return context;
    const [supplier] = this.suppliersRegions.values();
    return `${context}-${supplier.name}`;
  }

  private static isHttpUrl(url: string): boolean {
    try {
      const { protocol } = new URL(url);
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }

  async addDiscount(discountCode: string, validUntil: Date): Promise<void> {
    if (!discountCode) throw new DiscountRuleError("discountCode is required");

    if (validUntil < new Date()) throw new DiscountRuleError("validUntil cannot be in the past");
    if (this.discounts.length >= Product.MAX_ACTIVE_DISCOUNTS) {
      throw new DiscountRuleError(`Cannot have more than ${Product.MAX_ACTIVE_DISCOUNTS} discounts at the same time`);
    }

    this.discounts.push(discountCode);
    this.validUntil = validUntil;
    this.updatedAt = new Date();
    await prisma.product.update({
      where: { id: this.id },
      data: { discounts: this.discounts, updatedAt: this.updatedAt },
    });
  }

  // --- Suppliers ---

  async addSupplierToRegion(region: string, suppliers: Supplier[]): Promise<void> {
    const supplier = suppliers.find((candidate) => candidate.region === region);
    if (!supplier) throw new SupplierRuleError(`No supplier found for region ${region}`);

    this.suppliersRegions.set(region, supplier);
    this.updatedAt = new Date();

    await prisma.productSupplier.upsert({
      where: { productId_region: { productId: this.id, region: region } },
      create: { productId: this.id, region: region, supplierId: supplier.id },
      update: { supplierId: supplier.id },
    });
  }

  // --- Pricing ---

  getResellerPrice(): number {
    const marginAmount = (this.price.amount * this.price.margin) / 100;
    const vatAmount = (marginAmount * this.price.vat) / 100;
    return this.price.amount + marginAmount + vatAmount;
  }

  async setMargin(marginPercentage: number): Promise<void> {
    this.price.margin = marginPercentage;
    this.updatedAt = new Date();
    await prisma.product.update({
      where: { id: this.id },
      data: { priceMargin: marginPercentage, updatedAt: this.updatedAt },
    });
  }

  // --- Stock ---

  async receiveStock(quantity: number): Promise<void> {
    if (!this.warehouse) throw new StockRuleError(`Cannot receive stock for ${this.name}: no warehouse assigned`);

    this.stock += quantity;
    this.quantity += quantity;
    this.updatedAt = new Date();
    console.log(`Restocking ${this.name} at ${this.warehouse.name}`);
    await prisma.product.update({
      where: { id: this.id },
      data: { stock: this.stock, quantity: this.quantity, updatedAt: this.updatedAt },
    });
  }

  async sell(quantity: number): Promise<void> {
    if (this.stock < quantity) throw new StockRuleError("Not enough stock");

    this.stock -= quantity;
    this.updatedAt = new Date();

    if (this.stock === 0) {
      this.status = "out_of_stock";
    }

    await prisma.product.update({
      where: { id: this.id },
      data: { stock: this.stock, status: this.status, updatedAt: this.updatedAt },
    });

    this.notifySuppliers(`Product sold: ${this.name}`, `${quantity} unit(s) of ${this.name} were sold. Remaining stock: ${this.stock}.`);
  }

  // --- Lifecycle ---

  async deprecate(): Promise<void> {
    this.status = "deprecated";
    this.stock = 0;
    this.updatedAt = new Date();

    await prisma.product.update({
      where: { id: this.id },
      data: { status: this.status, stock: this.stock, updatedAt: this.updatedAt },
    });

    this.notifySuppliers(`Product deprecated: ${this.name}`, `The product ${this.name} has been deprecated and removed from the catalog.`);

    // Notify customers
    this.notifications.push(this.createNotification("customers@omniproduct.com", `Product no longer available: ${this.name}`, `${this.name} is no longer available.`));
  }

  private notifySuppliers(subject: string, body: string): void {
    for (const [, supplier] of this.suppliersRegions) {
      this.notifications.push(this.createNotification(supplier.email, subject, body));
    }
  }

  // small helper to cut down repetition in notif building
  private createNotification(recipient: string, subject: string, body: string): Notification {
    return {
      id: crypto.randomUUID(),
      recipient: recipient,
      subject: subject,
      body: body,
      channel: "email",
      sentAt: new Date(),
      productId: this.id,
    };
  }
}
