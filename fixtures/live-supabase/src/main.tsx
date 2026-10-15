import { StrictMode, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@supabase/supabase-js";
import "./styles.css";

type Order = { id: number; item: string; qty: number; customer: string };

const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);
// Every visitor gets their own anonymous user, so the policies have an auth.uid() to compare.
const signedIn = supabase.auth.getSession().then(async ({ data }) => void (data.session || (await supabase.auth.signInAnonymously())));

if (import.meta.env.PROD && "serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");

function App() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [item, setItem] = useState("Blue mug");
  const [note, setNote] = useState("");

  async function load() {
    const { data, error } = await supabase.from("orders").select("id, item, qty, customer").order("id");
    if (error) return setNote(error.message);
    setOrders(data);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    // A plain insert, no .select(): Save succeeds and the list reads 0 rows (the quiet bug).
    // .insert(row).select() would read the row back through the select policy and fail with a 403 instead.
    const { error } = await supabase.from("orders").insert({ item, qty: 1 });
    if (error) return setNote(error.message);
    setNote("Saved.");
    await load();
  }

  useEffect(() => void signedIn.then(load), []);

  return (
    <main className="app">
      <h1>Orders</h1>
      <form onSubmit={save}>
        <label htmlFor="item">Item</label>
        <input id="item" value={item} onChange={(e) => setItem(e.target.value)} maxLength={80} required />
        <button type="submit">Save</button>
      </form>
      <p role="status">{note}</p>
      {orders === null ? <p>Loading orders</p> : orders.length === 0 ? <p>No orders yet.</p> : (
        <ul>{orders.map((o) => <li key={o.id}>{o.item} x{o.qty}, {o.customer}</li>)}</ul>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
