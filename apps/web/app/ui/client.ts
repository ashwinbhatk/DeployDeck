"use client";
import { useCallback, useEffect, useState } from "react";

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...options });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/api/auth/")) window.location.replace("/login");
    const fields = Object.entries(result.fields ?? {}).map(([key, message]) => key + ": " + message);
    throw new Error(fields.length ? fields.join("\n") : result.error || "Request failed");
  }
  return result;
}

export function send<T>(path: string, data?: unknown, method = "POST") {
  return request<T>(path, { method, ...(data === undefined ? {} : {
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  }) });
}

export function useResource<T>(path: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    request<T>(path, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setData(result);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [path, revision]);
  const refresh = useCallback(() => setRevision(n => n + 1), []);
  return { data, error, refresh };
}
