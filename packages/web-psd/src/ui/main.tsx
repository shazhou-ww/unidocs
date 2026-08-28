import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import "./styles.css";

const host = document.getElementById("app");
if (!host) throw new Error("#app mount point missing from index.html");
createRoot(host).render(<App />);
