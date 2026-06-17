import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { App } from "./app";

const app = new App(document.getElementById("root")!);
app.init();
