"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy, ExternalLink, Share2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { nestFetch } from "@/lib/api/nest-client";

interface ShareButtonProps {
  projectId: string;
  projectName: string;
}

interface ShareLink {
  id: string;
  token: string;
  scope: "prd" | "prototype" | "both";
  status: "active" | "revoked";
  expiresAt?: string;
  isExpired?: boolean;
}

export function ShareButton({ projectId, projectName }: ShareButtonProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState<"prd" | "prototype" | "both">("both");
  const [expiresInDays, setExpiresInDays] = useState<number>(30);
  const [shareLinks, setShareLinks] = useState<ShareLink[]>([]);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const loadShareLinks = async () => {
    try {
      const response = await nestFetch<{ items: ShareLink[] }>(
        `/api/share-links/project/${projectId}`
      );
      // 只展示未吊销的链接，并计算过期状态
      const activeLinks = (response.items || [])
        .filter((link) => link.status !== "revoked")
        .map((link) => ({
          ...link,
          isExpired: link.expiresAt ? new Date(link.expiresAt) < new Date() : false,
        }));
      setShareLinks(activeLinks);
    } catch (error) {
      console.error("Failed to load share links:", error);
      toast.error("加载分享链接失败");
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (newOpen) {
      loadShareLinks();
    }
  };

  const handleCreateShare = async () => {
    setLoading(true);
    try {
      await nestFetch("/api/share-links", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          scope,
          expiresInDays,
        }),
      });

      toast.success("分享链接已创建");
      await loadShareLinks();
    } catch (error: any) {
      console.error("Failed to create share link:", error);
      toast.error(error.message || "创建分享链接失败");
    } finally {
      setLoading(false);
    }
  };

  const handleCopyLink = (token: string) => {
    const shareUrl = `${window.location.origin}/share/${token}`;
    navigator.clipboard.writeText(shareUrl);
    setCopiedToken(token);
    toast.success("链接已复制到剪贴板");
    setTimeout(() => setCopiedToken(null), 2000);
  };

  const handleRevoke = async (shareId: string) => {
    try {
      await nestFetch(`/api/share-links/${shareId}`, {
        method: "DELETE",
      });
      toast.success("分享链接已吊销");
      await loadShareLinks();
    } catch (error) {
      console.error("Failed to revoke share link:", error);
      toast.error("吊销分享链接失败");
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Share2 className="size-4" />
          分享
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>分享项目</DialogTitle>
          <DialogDescription>
            生成分享链接，其他用户登录后可查看 {projectName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Create new share link */}
          <div className="space-y-4 rounded-2xl border p-4">
            <h3 className="text-sm font-medium">创建新的分享链接</h3>

            <div className="grid gap-4">
              <div className="space-y-2">
                <Label htmlFor="scope">分享内容</Label>
                <Select value={scope} onValueChange={(v: any) => setScope(v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="prd">仅需求文档</SelectItem>
                    <SelectItem value="prototype">仅原型</SelectItem>
                    <SelectItem value="both">文档和原型</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="expires">有效期（天）</Label>
                <Input
                  id="expires"
                  type="number"
                  min={1}
                  max={365}
                  value={expiresInDays}
                  onChange={(e) => setExpiresInDays(Number(e.target.value))}
                />
              </div>

              <Button onClick={handleCreateShare} disabled={loading} className="w-full">
                {loading ? "创建中..." : "生成分享链接"}
              </Button>
            </div>
          </div>

          {/* Existing share links */}
          {shareLinks.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium">已创建的分享链接</h3>
              <div className="max-h-[300px] space-y-2 overflow-y-auto">
                {shareLinks.map((link) => (
                  <div
                    key={link.id}
                    className="flex items-center justify-between rounded-xl border p-3"
                  >
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">
                          {link.scope === "prd"
                            ? "需求文档"
                            : link.scope === "prototype"
                            ? "原型"
                            : "文档+原型"}
                        </Badge>
                        {link.isExpired && (
                          <Badge variant="destructive">已过期</Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        过期时间：
                        {link.expiresAt
                          ? new Date(link.expiresAt).toLocaleDateString("zh-CN")
                          : "永久"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => handleCopyLink(link.token)}
                        disabled={link.isExpired}
                      >
                        {copiedToken === link.token ? (
                          <Check className="size-4 text-green-600" />
                        ) : (
                          <Copy className="size-4" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => window.open(`/share/${link.token}`, "_blank")}
                        disabled={link.isExpired}
                      >
                        <ExternalLink className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => handleRevoke(link.id)}
                      >
                        <Trash2 className="size-4 text-red-600" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
