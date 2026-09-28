// Translated from Models/{Product,Price,Notification,Supplier,Warehouse}.cs
//
// The C# version kept two representations of the same data in sync by hand:
// domain fields marked [NotMapped] (Price, Discounts, Images, SuppliersRegions,
// Warehouse) plus flattened EF columns (PriceAmount/DiscountsCsv/ImagesJson/...),
// reconciled via SyncEfColumns()/HydrateFromEfColumns(). Prisma maps Decimal,
// String[] and Json columns natively (see schema.prisma), so that flattening
// and the two sync methods are gone: PrismaClient reads/writes plain objects
// and there is exactly one representation of each field.

import { PrismaClient, Prisma } from "@prisma/client";

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
  amount: number;
  currency: string;
  margin: number; // percentage
  vat: number; // percentage, applied on margin only

  constructor(amount: number, currency: string) {
    this.amount = amount;
    this.currency = currency;
    this.margin = 15;
    this.vat = 20;
  }

  getResellerPrice(): number {
    const marginAmount = (this.amount * this.margin) / 100;
    const vatAmount = (marginAmount * this.vat) / 100;
    return this.amount + marginAmount + vatAmount;
  }

  getAmount(): number {
    return this.amount;
  }

  setAmount(amount: number): void {
    this.amount = amount;
  }

  getCurrency(): string {
    return this.currency;
  }

  setCurrency(currency: string): void {
    this.currency = currency;
  }

  getMargin(): number {
    return this.margin;
  }

  setMargin(margin: number): void {
    this.margin = margin;
  }
}

export class Product {
  private static readonly MAX_DISCOUNTS = 2;

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
  nextStatus: ProductStatus | undefined;

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
    let label: string;
    if (this.status === "deprecated") {
      label = `[DISCONTINUED] ${this.name}`;
    } else {
      if (this.stock === 0) {
        label = `[OUT OF STOCK] ${this.name}`;
      } else {
        if (this.status === "active") {
          label = this.name;
        } else {
          label = this.name;
        }
      }
    }
    return label;
  }

  // --- Catalog / images / discounts ---

  async addImage(context: string, url: string): Promise<void> {
    if (!url) {
      throw new Error("url is required");
    }
    if (!Product.isHttpUrl(url)) {
      throw new Error("url must start with http(s) and be a valid absolute URL");
    }

    const isOverwrite = this.images[context] !== undefined;
    this.images[isOverwrite ? this.buildOverwriteKey(context) : context] = url;
    this.updatedAt = new Date();
    await prisma.product.update({
      where: { id: this.id },
      data: { images: this.images as Prisma.InputJsonValue, updatedAt: this.updatedAt },
    });
  }

  // An existing image is never replaced in place: the new url is stored under a
  // key derived from the regional suppliers, so both versions stay reachable.
  private buildOverwriteKey(context: string): string {
    let key = context;
    for (const [, supplier] of this.suppliersRegions) {
      if (!supplier.region) {
        // Supplier has NO region at all (empty string, null, undefined).
        // Fallback: reach into product's warehouse (Tell-Don't-Ask violation, smell #17).
        // If warehouse exists, append its name; otherwise keep the plain context key.
        key = this.warehouse ? `${context}-${this.warehouse.name}` : context;
        continue;
      }
      if (!supplier.email) {
        // Supplier has a region but NO email field (empty string, falsy).
        // Fall back to generic "-supplier" marker, losing the supplier's identity.
        key = `${context}-supplier`;
        continue;
      }
      if (!Product.hasParseableEmail(supplier.email)) {
        // Supplier has a region and email field, but email is malformed (missing valid @domain).
        // Treat as a data integrity error: throw instead of gracefully degrading.
        throw new Error(`Supplier ${supplier.name} has a malformed email: ${supplier.email}`);
      }
      key = `${context}-${supplier.name}`;
    }
    return key;
  }

  // `startsWith("http")` also accepted "httpfoo" and rejected nothing else:
  // let the URL parser decide, and only keep the two schemes we serve.
  private static isHttpUrl(url: string): boolean {
    try {
      const protocol = new URL(url).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }

  private static hasParseableEmail(email: string): boolean {
    const at = email.indexOf("@");
    return at > 0 && email.indexOf(".", at) > at;
  }

  getValidUntil(): Date | null {
    return this.validUntil;
  }

  setValidUntil(validUntil: Date | null): void {
    this.validUntil = validUntil;
  }

  async addDiscount(discountCode: string, validUntil: Date): Promise<void> {
    if (!discountCode) {
      throw new Error("discountCode is required");
    }
    if (!validUntil) {
      throw new Error("validUntil is required");
    }
    if (validUntil < new Date()) {
      throw new Error("validUntil cannot be in the past");
    }
    if (this.discounts.length >= Product.MAX_DISCOUNTS) {
      throw new Error(`Cannot have more than ${Product.MAX_DISCOUNTS} discounts at the same time`);
    }

    this.discounts.push(discountCode);
    this.setValidUntil(validUntil);
    this.updatedAt = new Date();
    await prisma.product.update({
      where: { id: this.id },
      data: { discounts: this.discounts, updatedAt: this.updatedAt },
    });
  }

  // --- Suppliers ---

  async addSupplierToRegion(region: string, suppliers: Supplier[]): Promise<void> {
    const supplier = suppliers.find((candidate) => candidate.region === region);
    if (!supplier) throw new Error(`No supplier found for region ${region}`);

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
    this.stock += quantity;
    this.quantity += quantity;
    this.updatedAt = new Date();
    console.log(`Restocking ${this.name} at ${this.warehouse!.name}`);
    await prisma.product.update({
      where: { id: this.id },
      data: { stock: this.stock, quantity: this.quantity, updatedAt: this.updatedAt },
    });
  }

  async sell(quantity: number): Promise<void> {
    if (this.stock < quantity) throw new Error("Not enough stock");

    this.stock -= quantity;
    this.updatedAt = new Date();

    if (this.stock === 0) {
      this.nextStatus = "out_of_stock";
      this.status = this.nextStatus as ProductStatus;
    }

    await prisma.product.update({
      where: { id: this.id },
      data: { stock: this.stock, status: this.status, updatedAt: this.updatedAt },
    });

    // Notify all regional suppliers
    for (const [, supplier] of this.suppliersRegions) {
      this.notifications.push(this.createNotification(supplier.email, `Product sold: ${this.name}`, `${quantity} unit(s) of ${this.name} were sold. Remaining stock: ${this.stock}.`));
    }
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

    // Notify all regional suppliers
    for (const [, supplier] of this.suppliersRegions) {
      this.notifications.push(this.createNotification(supplier.email, `Product deprecated: ${this.name}`, `The product ${this.name} has been deprecated and removed from the catalog.`));
    }

    // Notify customers
    this.notifications.push(this.createNotification("customers@omniproduct.com", `Product no longer available: ${this.name}`, `${this.name} is no longer available.`));
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
