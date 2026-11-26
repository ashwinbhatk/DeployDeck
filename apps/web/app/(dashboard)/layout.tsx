import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { GET as currentUser } from "../api/auth/me/route";
import { Logout } from "../ui/logout";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const response = await currentUser(new Request("http://localhost/api/auth/me", { headers: await headers() }));
  if (response.status === 401) redirect("/login");
  if (!response.ok) throw new Error("Unable to load account");
  const { user } = await response.json();
  return <><header className="topbar"><nav><Link href="/" className="brand"><i aria-hidden="true"/>DeployDeck</Link>
    <Link href="/">Projects</Link><span className="account">{user.email}</span><Logout /></nav></header>
    <main className="workspace">{children}</main></>;
}
