// Mirror of lib/pricing.ts monthlyPlans — only plans with syncToStripe !== false.
export const appMonthlyPlans = [
  { id: "essential",       title: "Essential Care",       amountCents: 9900,  currency: "cad" },
  { id: "growth",          title: "Growth Plan",          amountCents: 24900, currency: "cad" },
  { id: "premium",         title: "Premium Plan",         amountCents: 49900, currency: "cad" },
  { id: "managed-content", title: "Managed Content Plan", amountCents: 79900, currency: "cad" },
];
