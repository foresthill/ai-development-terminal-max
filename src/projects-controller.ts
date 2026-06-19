// Project + saved-project lifecycle, extracted from app.ts. Owns opening a
// folder/clone as a project, the saved-bookmark slots (record/open/remove/
// rename), and nothing else. Talks to App state through a small context object
// of accessors/callbacks so the App stays the single source of truth.
import { Project, createProject } from "./project";
import { SavedProject, saveProjects } from "./persistence";
import { basename } from "./agent";
import { askText, toast, pickDirectory } from "./ui";
import { isGitRepo, gitClone } from "./git";
import { t } from "./i18n";

export interface ProjectsCtx {
  projects(): Project[];
  saved(): SavedProject[];
  home(): string;
  /// Make `p` the active project (set ap + reset focus/view), as App defines it.
  activate(p: Project): void;
  render(): void;
  addAgentToActive(): Promise<void>;
  addAgentWithCwd(project: Project, cwd: string | null, focus?: boolean): Promise<void>;
}

export class ProjectsController {
  constructor(private ctx: ProjectsCtx) {}

  async openFolderProject() {
    let path: string | null;
    try {
      path = await pickDirectory(this.ctx.home());
    } catch {
      path = await askText({
        title: t("modal.openTitle"),
        placeholder: "/Users/you/dev/myrepo",
        value: this.ctx.home() + "/",
      });
    }
    if (!path) return;
    const git = await isGitRepo(path);
    await this.openProject(basename(path) || path, path, git);
  }

  async cloneProject() {
    const url = await askText({
      title: t("modal.cloneTitle"),
      placeholder: "https://github.com/user/repo.git",
    });
    if (!url) return;
    toast(t("toast.cloning", url));
    try {
      const path = await gitClone(url);
      await this.openProject(basename(path) || "repo", path, true);
      toast(t("toast.cloned", basename(path)));
    } catch (e) {
      toast(t("toast.cloneFail", String(e)), "error");
    }
  }

  /// Create + activate a project, record it as a saved bookmark, add first agent.
  async openProject(label: string, path: string, isGit: boolean) {
    const p = createProject(label, path, isGit);
    this.ctx.projects().push(p);
    this.ctx.activate(p);
    this.recordSaved(label, path, isGit);
    if (isGit) await this.ctx.addAgentToActive();
    else await this.ctx.addAgentWithCwd(p, path);
  }

  recordSaved(label: string, path: string, isGit: boolean) {
    const saved = this.ctx.saved();
    if (!saved.some((s) => s.path === path)) {
      saved.push({ label, path, isGit });
      saveProjects(saved);
    }
  }

  openSavedProject(sp: SavedProject) {
    void this.openProject(sp.label, sp.path, sp.isGit);
  }

  removeSavedProject(path: string) {
    const saved = this.ctx.saved();
    const i = saved.findIndex((s) => s.path === path);
    if (i >= 0) saved.splice(i, 1);
    saveProjects(saved);
    this.ctx.render();
  }

  async renameSavedProject(path: string) {
    const sp = this.ctx.saved().find((s) => s.path === path);
    if (!sp) return;
    const v = await askText({ title: t("saved.renameTitle"), value: sp.label });
    if (!v) return;
    sp.label = v;
    for (const p of this.ctx.projects()) if (p.root === path) p.name = v;
    saveProjects(this.ctx.saved());
    this.ctx.render();
  }
}
