import { redirect } from "next/navigation";

export default function AdminIndex(): never {
  redirect("/admin/team");
}
