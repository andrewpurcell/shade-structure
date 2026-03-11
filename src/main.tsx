import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const app = document.getElementById("app");
if (!app) throw new Error("#app not found");

createRoot(app).render(<App />);
