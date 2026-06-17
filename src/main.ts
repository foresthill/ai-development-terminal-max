import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { App } from "./app";
import { applyStatic } from "./i18n";

applyStatic();
const app = new App(document.getElementById("root")!);
app.init();
