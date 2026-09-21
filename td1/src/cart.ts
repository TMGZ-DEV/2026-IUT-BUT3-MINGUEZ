/**
 * TD1 — Code à revoir : la caisse du magasin.
 *
 * Ce fichier contient volontairement plusieurs problèmes (logique, typage,
 * lisibilité, conception). À vous de les identifier en commentaires de
 * revue, puis d'en corriger au moins trois.
 */

interface Item {
  name: string;
  price: number;
  quantity: number;
}

const TAX_RATE = 0.2;

// Refuse une ligne qui fausserait le total (remise déguisée, NaN affiché...)
function assertValidItem(item: Item): void {
  if (!Number.isFinite(item.price) || item.price < 0) {
    throw new Error(`Prix invalide pour "${item.name}" : ${item.price}`);
  }
  if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
    throw new Error(`Quantité invalide pour "${item.name}" : ${item.quantity}`);
  }
}

export function totalTTC(cart: Item[]): number {
  let sum = 0;
  for (const item of cart) {
    assertValidItem(item);
    sum += item.price * item.quantity;
  }
  return sum + sum * TAX_RATE;
}

// Formate un prix en euros
export function formatPrice(value: number): string {
  return value.toFixed(2) + " €";
}

// Encaisse le panier : affiche le total et prépare le paiement
export function checkout(cart: Item[]) {
  if (cart.length === 0) {
    console.log("Panier vide");
    return;
  }
  const amountDue = totalTTC(cart);
  console.log("Total à payer : " + formatPrice(amountDue));
  // TODO: intégrer le paiement
}
