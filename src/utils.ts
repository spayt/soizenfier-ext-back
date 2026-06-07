import Stripe from "stripe";

export const getStripe = (secretKey: string): Stripe => {
  const stripe = new Stripe(secretKey, {
    apiVersion: "2022-11-15",
  });
  return stripe;
};

export interface GeneralParams {
  test: boolean;
  //   supportEmails: string[];
}
