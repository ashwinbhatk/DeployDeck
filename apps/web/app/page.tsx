export default function Home() {
  return <main><p className="eyebrow">DEPLOYDECK / FOUNDATION</p>
    <h1>Your code.<br />Your infrastructure.</h1>
    <p>A single-host deployment platform built around real containers, durable jobs, and health-gated routing.</p>
    <section><h2>Phase 1</h2><p>The control plane, database schema, worker bootstrap, and proxy configuration are in place. Authentication and deployments arrive in later phases.</p>
    <a href="/api/health">Check database readiness <span aria-hidden="true">&rarr;</span></a></section>
    <footer>Next.js + PostgreSQL + Docker + Caddy</footer>
  </main>;
}
