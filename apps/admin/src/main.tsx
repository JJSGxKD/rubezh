import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Нет элемента #root в index.html");

createRoot(root).render(
  <StrictMode>
    <main className="p-6">
      <h1 className="text-xl text-text">Рубеж — панель</h1>
    </main>
  </StrictMode>,
);
