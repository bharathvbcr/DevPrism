import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  FolderOpenIcon,
  FolderPlusIcon,
  ClockIcon,
  XIcon,
} from "lucide-react";
import { useProjectStore } from "@/stores/project-store";
import { useDocumentStore } from "@/stores/document-store";
import { Button } from "@/components/ui/button";
import { ProjectWizard } from "./project-wizard";

export function ProjectPicker() {
  const [showWizard, setShowWizard] = useState(false);

  const recentProjects = useProjectStore((s) => s.recentProjects);
  const addRecentProject = useProjectStore((s) => s.addRecentProject);
  const removeRecentProject = useProjectStore((s) => s.removeRecentProject);
  const openProject = useDocumentStore((s) => s.openProject);

  const handleOpenFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Open Project Folder",
    });
    if (selected) {
      addRecentProject(selected);
      await openProject(selected);
    }
  };

  const handleOpenRecent = async (path: string) => {
    addRecentProject(path);
    await openProject(path);
  };

  if (showWizard) {
    return <ProjectWizard onBack={() => setShowWizard(false)} />;
  }

  return (
    <div className="flex h-full items-center justify-center bg-background">
      <div className="flex w-full max-w-md flex-col items-center gap-8 px-8">
        <div className="flex flex-col items-center gap-2">
          <img src="/icon-192.png" alt="ClaudePrism" className="size-16" />
          <h1 className="font-bold text-2xl">ClaudePrism</h1>
          <p className="text-center text-muted-foreground text-sm">
            AI-powered academic writing workspace
          </p>
        </div>

        <div className="flex w-full gap-3">
          <Button
            onClick={() => setShowWizard(true)}
            size="lg"
            variant="outline"
            className="flex-1 gap-2"
          >
            <FolderPlusIcon className="size-5" />
            New Project
          </Button>
          <Button
            onClick={handleOpenFolder}
            size="lg"
            className="flex-1 gap-2"
          >
            <FolderOpenIcon className="size-5" />
            Open Folder
          </Button>
        </div>

        {recentProjects.length > 0 && (
          <div className="w-full">
            <div className="mb-3 flex items-center gap-2 text-muted-foreground text-sm">
              <ClockIcon className="size-4" />
              <span>Recent Projects</span>
            </div>
            <div className="space-y-1">
              {recentProjects.map((project) => (
                <div
                  key={project.path}
                  className="group flex items-center gap-2 rounded-md px-3 py-2 transition-colors hover:bg-muted"
                >
                  <button
                    className="flex flex-1 flex-col items-start overflow-hidden text-left"
                    onClick={() => handleOpenRecent(project.path)}
                  >
                    <span className="truncate font-medium text-sm">
                      {project.name}
                    </span>
                    <span className="truncate text-muted-foreground text-xs">
                      {project.path}
                    </span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0 opacity-0 group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeRecentProject(project.path);
                    }}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
