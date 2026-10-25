import { db } from "@/db";
import { stripe } from "@/lib/stripe";
import { headers } from "next/headers";
import type Stripe from "stripe";

type PeriodItem = { price?: { id?: string } | null };
type PeriodField = 'current_period_start' | 'current_period_end';
type PlanItem = (items: PeriodItem[]) => PeriodItem | undefined;

// Typed like the removed field, which was also absent at runtime when Stripe omitted it.
function subscriptionPeriod(subscription: object, field: PeriodField, planItem?: PlanItem): number {
  const legacy: unknown = Reflect.get(subscription, field);
  if (typeof legacy === 'number') return legacy;
  const list: unknown = Reflect.get(subscription, 'items');
  const data: unknown = list && typeof list === 'object' ? Reflect.get(list, 'data') : undefined;
  const items = (Array.isArray(data) ? data : []).filter(
    (item): item is PeriodItem => typeof item === 'object' && item !== null,
  );
  const periods = new Set(items.map((item) => Reflect.get(item, field)));
  const chosen = periods.size === 1 ? items[0] : planItem?.(items);
  const value: unknown = chosen ? Reflect.get(chosen, field) : undefined;
  return (typeof value === 'number' ? value : undefined) as number;
}

function getSubscriptionPeriodEnd(subscription: object, planItem?: PlanItem): number {
  return subscriptionPeriod(subscription, 'current_period_end', planItem);
}

export async function POST(request: Request) {
  const body = await request.text();
  const signature = headers().get("Stripe-Signature") ?? "";

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET || "",
    );
  } catch (err) {
    return new Response(
      `Webhook Error: ${
        err instanceof Error
          ? err.message
          : "Webhook signature verification failed."
      }`,
      { status: 400 },
    );
  }

  const session = event.data.object as Stripe.Checkout.Session;

  const subscription = await stripe.subscriptions.retrieve(
    session.subscription as string,
  );

  if (!subscription) {
    return new Response(`Webhook Error: No subscription found`, {
      status: 400,
    });
  }

  // Handle events
  try {
    switch (event.type) {
      case "checkout.session.completed":
        if (!session?.metadata?.userId) return;
        // Update User & Create Stripe Data
        await db.user.update({
          where: {
            id: session.metadata.userId,
          },
          data: {
            stripeSubscriptionId: subscription.id,
            stripeCustomerId: subscription.customer as string,
            stripePriceId: subscription.items.data[0]?.price.id,
            stripeCurrentPeriodEnd: new Date(
              (getSubscriptionPeriodEnd(subscription, (items) => items[0])) * 1000,
            ),
          },
        });
        break;
      case "invoice.payment_succeeded":
        // Update User & Update Stripe Data
        await db.user.update({
          where: {
            stripeSubscriptionId: subscription.id,
          },
          data: {
            stripePriceId: subscription.items.data[0]?.price.id,
            stripeCurrentPeriodEnd: new Date(
              (getSubscriptionPeriodEnd(subscription, (items) => items[0])) * 1000,
            ),
          },
        });
        break;
    }
  } catch (err) {
    return new Response(
      `Webhook Error: ${
        err instanceof Error ? err.message : "Update booking failed."
      }`,
      { status: 400 },
    );
  }

  // Response
  return new Response(null, { status: 200 });
}
