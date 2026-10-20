import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@openmatel/ui/styles.css";
import "./styles.css";

import { App } from "./App.js";

const root = document.getElementById("root");
if (root === null) throw new Error("OpenMaTel: #root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
