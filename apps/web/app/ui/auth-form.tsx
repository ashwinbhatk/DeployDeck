"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { send } from "./client";

export function AuthForm({ signup = false }: { signup?: boolean }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fields = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true); setError("");
    try { await send("/api/auth/" + (signup ? "signup" : "login"), fields); window.location.assign("/"); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return <main className="auth"><div className="brand"><i aria-hidden="true"/>DeployDeck</div>
    <section className="panel"><h1>{signup ? "Create account" : "Sign in"}</h1>
      <form onSubmit={submit}><label>Email<input type="email" name="email" autoComplete="email" required /></label>
      <label>Password<input type="password" name="password" autoComplete={signup ? "new-password" : "current-password"} minLength={signup ? 12 : 1} required /></label>
      {signup && <small>Use at least 12 characters.</small>}
      {error && <p role="alert">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? "Submitting..." : signup ? "Create account" : "Sign in"}</button></form>
      <p>{signup ? "Already registered?" : "New to DeployDeck?"} <Link href={signup ? "/login" : "/signup"}>{signup ? "Sign in" : "Create an account"}</Link></p>
    </section></main>;
}
