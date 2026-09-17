import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.jsx";
import { WindowCloseDialog } from "./components/window-close-dialog.jsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
    <WindowCloseDialog />
  </React.StrictMode>
);
