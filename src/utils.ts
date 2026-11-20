import Stripe from "stripe";

export const STRIPE_API_VERSION = "2026-11-18.endive" as const;

export const getStripe = (secretKey: string): Stripe => {
  // Pinned explicitly so a future library upgrade never changes the API
  // version (and the shape of the objects we read) silently.
  const stripe = new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
  });
  return stripe;
};

export interface GeneralParams {
  test: boolean;
  //   supportEmails: string[];
}
