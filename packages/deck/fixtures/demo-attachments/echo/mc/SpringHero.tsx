// SpringHero.tsx - homepage hero for the spring stationery range.
// Two image variants so the A/B test can swap without a deploy.

type Variant = "a" | "b";

const IMAGES: Record<Variant, string> = {
  a: "/images/spring-hero-a.png",
  b: "/images/spring-hero-b.png",
};

export function SpringHero({ variant = "a" }: { variant?: Variant }) {
  return (
    <section className="spring-hero">
      <img src={IMAGES[variant]} alt="Greeting cards and pressed flowers on a teal burst" />
      <div className="spring-hero__copy">
        <h1>Paper and petals, made to order</h1>
        <p>The spring range is here: notebooks, cards and gift boxes, pressed by hand.</p>
        <a className="button" href="/collections/spring">Shop the range</a>
      </div>
    </section>
  );
}
