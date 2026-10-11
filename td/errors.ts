// Business rule violations raised by Product. A caller can catch
// ProductRuleError to tell a broken rule apart from a technical failure
// (database down...), or one subclass to react to one kind of rule.
export class ProductRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class StockRuleError extends ProductRuleError {}
export class DiscountRuleError extends ProductRuleError {}
export class SupplierRuleError extends ProductRuleError {}
export class ImageRuleError extends ProductRuleError {}
