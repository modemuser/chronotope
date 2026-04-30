import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

const HowItWorks = lazy(() =>
  import("./HowItWorks").then((m) => ({ default: m.HowItWorks })),
);

const path =
  typeof window !== "undefined" ? window.location.pathname : "/";
const isIdea = path === "/idea" || path === "/idea/";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isIdea ? (
      <Suspense fallback={null}>
        <HowItWorks />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
