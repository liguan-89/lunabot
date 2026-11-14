import type { PaymentCardInput, PaymentCardView } from "../../shared/payment-card";
import { api } from "@/state/store";

export async function listPaymentCards(): Promise<PaymentCardView[]> {
  return (await api<{ cards: PaymentCardView[] }>("/api/payment-cards")).cards;
}

export async function addPaymentCard(input: PaymentCardInput): Promise<PaymentCardView> {
  return (await api<{ card: PaymentCardView }>("/api/payment-cards", { method: "POST", body: JSON.stringify(input) })).card;
}

export async function removePaymentCard(id: string): Promise<void> {
  await api(`/api/payment-cards/${encodeURIComponent(id)}`, { method: "DELETE" });
}
