import { PublicPrototype } from "@/components/studio/public-prototype";

// The token is request-scoped and the route intentionally renders a blocking
// share shell before the client fetches its public projection.
export const instant = false;

export default async function PrototypeSharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PublicPrototype token={token} />;
}
