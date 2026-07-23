import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { LocaleProvider } from "./i18n";
import { ThemeProvider } from "./theme/ThemeProvider";
import DesktopWindowFrame from "./components/DesktopWindowFrame";

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <LocaleProvider>
      <DesktopWindowFrame>
        <App />
      </DesktopWindowFrame>
    </LocaleProvider>
  </ThemeProvider>,
);
