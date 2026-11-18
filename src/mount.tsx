import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DesktopMountView } from "./components/DesktopMountView";
import { PageBoundary } from "./components/PageBoundary";
import { bootstrapBrand } from "./lib/brand";
import { applyFont, readFont } from "./lib/fonts";
import { loadPageLanguage } from "./lib/language-preference";
import { settleInterfaceMode } from "./lib/new-look";
import { applySkinChoice, readSkinChoice } from "./lib/skins";
import { StoreProvider } from "./state/store";
import "./styles.css";

if (window.ogb?.desktopMount) {
  settleInterfaceMode();
  applySkinChoice(readSkinChoice());
  applyFont(readFont());
  document.documentElement.style.background = document.body.style.background = "transparent";
  const botId = new URLSearchParams(location.search).get("botId");
  void Promise.all([bootstrapBrand(), loadPageLanguage()]).then(() => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <PageBoundary>
          <StoreProvider>
            <DesktopMountView botId={botId} />
          </StoreProvider>
        </PageBoundary>
      </StrictMode>,
    );
  });
} else {
  location.replace(`/${location.search}${location.hash}`);
}
