export default function Home() {
  return <main><p className="eyebrow">DEPLOYDECK / CONTROL PLANE</p>
    <h1>Your code.<br />Your infrastructure.</h1>
    <p>A single-host deployment platform built around real containers, durable jobs, and health-gated routing.</p>
    <section><h2>Phase 2</h2><p>Authentication and project APIs are ready, with encrypted environment variables and ownership checks. The deployment engine and dashboard arrive in later phases.</p>
    <a href="/api/health">Check database readiness <span aria-hidden="true">&rarr;</span></a></section>
    <footer>Next.js + PostgreSQL + Docker + Caddy</footer>
  </main>;
}
