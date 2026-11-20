// Mirror of lib/pricing.ts monthlyPlans — only plans with syncToStripe !== false.
export const appMonthlyPlans = [
  { id: "essential",       title: "Essential Care",       amountCents: 4950,  currency: "cad" },
  { id: "growth",          title: "Growth Plan",          amountCents: 12450, currency: "cad" },
  { id: "premium",         title: "Premium Plan",         amountCents: 24950, currency: "cad" },
  { id: "managed-content", title: "Managed Content Plan", amountCents: 39950, currency: "cad" },
];
