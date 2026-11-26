"use client";
import { useState } from "react";
import { send } from "./client";
export function Logout() {
  const [error, setError] = useState("");
  return <><button onClick={async () => {
    try { await send("/api/auth/logout"); window.location.replace("/login"); }
    catch (e) { setError((e as Error).message); }
  }}>Log out</button>{error && <span role="alert">{error}</span>}</>;
}
