import Stripe from "stripe";

// In-memory stand-in for the Stripe client returned by `getStripe()`.
// Objects mirror the plain-JSON shapes the real API returns. Webhook signing
// uses the real Stripe library so signature verification is genuine.
// Real-API behaviour (price creation, checkout amounts) is covered by
// scripts/verify-stripe-prices.ts against Stripe test mode.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

const realWebhooks = new Stripe("sk_test_dummy", { apiVersion: "2022-11-15" }).webhooks;

export class FakeStripe {
  keysUsed: string[] = [];
  customerStore = new Map<string, Obj>();
  productStore = new Map<string, Obj>();
  priceStore = new Map<string, Obj>();
  subscriptionStore = new Map<string, Obj>();
  checkoutSessionsCreated: Obj[] = [];
  portalSessionsCreated: Obj[] = [];
  failCheckout = false;
  private counter = 0;

  webhooks = realWebhooks;

  reset() {
    this.keysUsed = [];
    this.customerStore.clear();
    this.productStore.clear();
    this.priceStore.clear();
    this.subscriptionStore.clear();
    this.checkoutSessionsCreated = [];
    this.portalSessionsCreated = [];
    this.failCheckout = false;
    this.counter = 0;
  }

  private nextId(prefix: string) {
    this.counter += 1;
    return `${prefix}_fake${this.counter}`;
  }

  customers = {
    create: async (params: Obj) => {
      const customer = { id: this.nextId("cus"), object: "customer", ...params };
      this.customerStore.set(customer.id, customer);
      return customer;
    },
  };

  checkout = {
    sessions: {
      create: async (params: Obj) => {
        if (this.failCheckout) throw new Error("Stripe is down");
        this.checkoutSessionsCreated.push(params);
        const id = this.nextId("cs_test");
        return { id, object: "checkout.session", url: `https://checkout.stripe.test/${id}` };
      },
    },
  };

  billingPortal = {
    sessions: {
      create: async (params: Obj) => {
        this.portalSessionsCreated.push(params);
        return { id: this.nextId("bps"), url: "https://billing.stripe.test/session" };
      },
    },
  };

  products = {
    search: async ({ query }: { query: string }) => {
      const match = /metadata\['appPlanId'\]:'([^']+)'/.exec(query);
      const data = [...this.productStore.values()].filter(
        (p) => match && p.metadata?.appPlanId === match[1],
      );
      return { object: "search_result", data };
    },
    create: async (params: Obj) => {
      const product = { id: this.nextId("prod"), object: "product", active: true, ...params };
      this.productStore.set(product.id, product);
      return product;
    },
    update: async (id: string, params: Obj) => {
      const product = { ...this.productStore.get(id)!, ...params };
      this.productStore.set(id, product);
      return product;
    },
  };

  prices = {
    create: async (params: Obj) => {
      const price = { id: this.nextId("price"), object: "price", active: true, ...params };
      this.priceStore.set(price.id, price);
      return price;
    },
    list: async ({ product, active }: { product?: string; active?: boolean }) => ({
      object: "list",
      data: [...this.priceStore.values()].filter(
        (p) => (product === undefined || p.product === product) &&
          (active === undefined || p.active === active),
      ),
    }),
    retrieve: async (id: string) => {
      const price = this.priceStore.get(id);
      if (!price) throw new Error(`No such price: '${id}'`);
      return price;
    },
    update: async (id: string, params: Obj) => {
      const price = { ...this.priceStore.get(id)!, ...params };
      this.priceStore.set(id, price);
      return price;
    },
  };

  subscriptions = {
    retrieve: async (id: string) => {
      const sub = this.subscriptionStore.get(id);
      if (!sub) throw new Error(`No such subscription: '${id}'`);
      return sub;
    },
    list: async ({ customer }: { customer: string }) => ({
      object: "list",
      data: [...this.subscriptionStore.values()].filter((s) => s.customer === customer),
    }),
  };

  /** Seeds a price shaped like the real `Stripe.Price` object. */
  addPrice(overrides: Obj = {}) {
    const price = {
      id: this.nextId("price"),
      object: "price",
      active: true,
      currency: "cad",
      unit_amount: 4950,
      recurring: { interval: "month" },
      ...overrides,
    };
    this.priceStore.set(price.id, price);
    return price;
  }

  /** Seeds a subscription shaped like the real `Stripe.Subscription` object. */
  addSubscription(overrides: Obj = {}) {
    const sub = {
      id: this.nextId("sub"),
      object: "subscription",
      customer: "cus_seed",
      status: "active",
      metadata: {},
      items: {
        object: "list",
        data: [{
          id: this.nextId("si"),
          price: {
            id: "price_seed",
            unit_amount: 4950,
            currency: "cad",
            recurring: { interval: "month" },
          },
        }],
      },
      current_period_start: 1_760_000_000,
      current_period_end: 1_762_592_000,
      cancel_at: null,
      canceled_at: null,
      ...overrides,
    };
    this.subscriptionStore.set(sub.id, sub);
    return sub;
  }
}

export const fakeStripe = new FakeStripe();
