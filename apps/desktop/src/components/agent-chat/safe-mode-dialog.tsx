import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ShieldAlertIcon } from "lucide-react";

interface ApprovalRequest {
  tab_id: string;
  action_id: string;
  action: string;
}

export function SafeModeDialog() {
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);

  useEffect(() => {
    const unlisten = listen<ApprovalRequest>(
      "claude-request-approval",
      (event) => {
        setRequests((prev) => [...prev, event.payload]);
      },
    );

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const handleResponse = async (actionId: string, approved: boolean) => {
    setRequests((prev) => prev.filter((r) => r.action_id !== actionId));
    try {
      await invoke("resolve_agent_approval", { actionId, approved });
    } catch (err) {
      console.error("Failed to resolve approval:", err);
    }
  };

  if (requests.length === 0) return null;

  const currentRequest = requests[0];

  return (
    <Dialog open={true}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlertIcon className="size-5 text-amber-500" />
            Safe Mode Approval Required
          </DialogTitle>
          <DialogDescription>
            The agent wants to run a protected action. Do you allow this?
          </DialogDescription>
        </DialogHeader>

        <div className="my-4 rounded-md border border-amber-500/20 bg-amber-500/10 p-4">
          <pre className="whitespace-pre-wrap font-mono text-amber-900 text-sm dark:text-amber-200">
            {currentRequest.action}
          </pre>
        </div>

        <DialogFooter className="gap-2 sm:justify-end">
          <Button
            variant="outline"
            onClick={() => handleResponse(currentRequest.action_id, false)}
          >
            Deny
          </Button>
          <Button
            variant="default"
            className="bg-amber-600 text-white hover:bg-amber-700"
            onClick={() => handleResponse(currentRequest.action_id, true)}
          >
            Allow Action
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
