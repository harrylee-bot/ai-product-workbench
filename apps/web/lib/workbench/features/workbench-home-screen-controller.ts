"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { WorkbenchHomeProjectItem } from "./projects";
import {
  type CommunicationPreferences,
  useUpdateWorkbenchCommunicationPreferences,
  useWorkbenchCommunicationPreferences,
} from "./identity";
import {
  resolveWorkbenchModelChoiceKey,
  type WorkbenchModelCatalogState,
} from "./runtime-models";
import type { WorkbenchModelChoice } from "./workbench-presenter";

type CommunicationPreferencesPatch = Partial<Pick<
  CommunicationPreferences,
  "productUpdatesEmail" | "researchInvitations"
>>;

export type WorkbenchHomeScreenControllerOptions = {
  modelCatalogStatus: WorkbenchModelCatalogState["status"];
  modelChoices: readonly WorkbenchModelChoice[];
  onArchiveProject: (projectId: string) => Promise<unknown>;
  onDuplicateProject: (projectId: string) => Promise<unknown>;
};

export function useWorkbenchHomeScreenController({
  modelCatalogStatus,
  modelChoices,
  onArchiveProject,
  onDuplicateProject,
}: WorkbenchHomeScreenControllerOptions) {
  const communicationPreferencesQuery = useWorkbenchCommunicationPreferences();
  const updateCommunicationPreferences = useUpdateWorkbenchCommunicationPreferences();
  const [newsletterOpen, setNewsletterOpen] = useState(false);
  const [announcementOpen, setAnnouncementOpen] = useState(true);
  const [homeModel, setHomeModel] = useState("");
  const [homeModelMenuOpen, setHomeModelMenuOpen] = useState(false);
  const [homeStyleMenuOpen, setHomeStyleMenuOpen] = useState(false);
  const [homeMoreMenuOpen, setHomeMoreMenuOpen] = useState(false);
  const [mobileProjectsOpen, setMobileProjectsOpen] = useState(false);
  const [archiveProjectTarget, setArchiveProjectTarget] = useState<WorkbenchHomeProjectItem | null>(null);
  const [projectActionBusy, setProjectActionBusy] = useState(false);
  const [archiveFailed, setArchiveFailed] = useState(false);
  const projectActionBusyRef = useRef(false);
  const communicationPreferences = communicationPreferencesQuery.data?.value ?? null;
  const communicationPreferencesBusy = communicationPreferencesQuery.isPending
    || communicationPreferencesQuery.isFetching
    || updateCommunicationPreferences.isPending;

  const closeHomeMenus = useCallback(() => {
    setHomeModelMenuOpen(false);
    setHomeStyleMenuOpen(false);
    setHomeMoreMenuOpen(false);
  }, []);

  const saveCommunicationPreferences = useCallback((patch: CommunicationPreferencesPatch) => {
    if (!communicationPreferences || communicationPreferencesBusy) {
      toast.error("通信偏好尚未就绪，请重试");
      return;
    }
    void updateCommunicationPreferences.mutateAsync({
      request: {
        productUpdatesEmail: patch.productUpdatesEmail
          ?? communicationPreferences.productUpdatesEmail,
        researchInvitations: patch.researchInvitations
          ?? communicationPreferences.researchInvitations,
      },
    }).catch(() => toast.error("通信偏好保存失败，请重试"));
  }, [communicationPreferences, communicationPreferencesBusy, updateCommunicationPreferences]);

  const duplicateProject = useCallback((project: WorkbenchHomeProjectItem) => {
    if (projectActionBusyRef.current) return;
    projectActionBusyRef.current = true;
    setProjectActionBusy(true);
    void onDuplicateProject(project.id)
      .catch(() => toast.error("复制项目失败，请重试"))
      .finally(() => {
        projectActionBusyRef.current = false;
        setProjectActionBusy(false);
      });
  }, [onDuplicateProject]);

  const requestArchiveProject = useCallback((project: WorkbenchHomeProjectItem) => {
    setArchiveFailed(false);
    setArchiveProjectTarget(project);
  }, []);

  const confirmArchiveProject = useCallback(() => {
    if (
      !archiveProjectTarget
      || archiveProjectTarget.role !== "owner"
      || projectActionBusyRef.current
    ) return;
    projectActionBusyRef.current = true;
    setProjectActionBusy(true);
    setArchiveFailed(false);
    void onArchiveProject(archiveProjectTarget.id)
      .then(() => setArchiveProjectTarget(null))
      .catch(() => setArchiveFailed(true))
      .finally(() => {
        projectActionBusyRef.current = false;
        setProjectActionBusy(false);
      });
  }, [archiveProjectTarget, onArchiveProject]);

  const onArchiveDialogOpenChange = useCallback((open: boolean) => {
    if (!open && !projectActionBusy) setArchiveProjectTarget(null);
  }, [projectActionBusy]);

  const openNewsletter = useCallback(() => {
    setNewsletterOpen(true);
    if (communicationPreferencesQuery.isError) {
      void communicationPreferencesQuery.refetch();
    }
  }, [communicationPreferencesQuery]);

  const closeNewsletter = useCallback(() => setNewsletterOpen(false), []);
  const dismissAnnouncement = useCallback(() => setAnnouncementOpen(false), []);
  const toggleMobileProjects = useCallback(() => {
    setMobileProjectsOpen((open) => !open);
  }, []);
  const toggleHomeMoreMenu = useCallback(() => {
    setHomeModelMenuOpen(false);
    setHomeStyleMenuOpen(false);
    setHomeMoreMenuOpen((open) => !open);
  }, []);
  const selectHomeModel = useCallback((model: string) => {
    setHomeModel(model);
    setHomeModelMenuOpen(false);
  }, []);
  const closeHomeModelMenu = useCallback(() => {
    setHomeModelMenuOpen(false);
  }, []);
  const toggleHomeModelMenu = useCallback(() => {
    setHomeStyleMenuOpen(false);
    setHomeModelMenuOpen((open) => !open);
  }, []);
  const toggleHomeStyleMenu = useCallback(() => {
    setHomeModelMenuOpen(false);
    setHomeStyleMenuOpen((open) => !open);
  }, []);

  useEffect(() => {
    if (modelCatalogStatus === "loading" || modelCatalogStatus === "error") return;
    const nextModel = resolveWorkbenchModelChoiceKey(homeModel, modelChoices);
    if (nextModel !== homeModel) setHomeModel(nextModel);
  }, [homeModel, modelCatalogStatus, modelChoices]);

  useEffect(() => {
    if (modelCatalogStatus !== "ready") setHomeModelMenuOpen(false);
  }, [modelCatalogStatus]);

  useEffect(() => {
    const closeMenus = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeHomeMenus();
    };
    window.addEventListener("keydown", closeMenus);
    return () => window.removeEventListener("keydown", closeMenus);
  }, [closeHomeMenus]);

  useEffect(() => {
    const closeMenuOnOutsidePointer = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Element
        && (
          target.closest('[role="menu"]')
          || target.closest('[aria-haspopup="menu"]')
          || target.closest("[data-home-more-menu]")
        )
      ) {
        return;
      }
      closeHomeMenus();
    };
    window.addEventListener("mousedown", closeMenuOnOutsidePointer, true);
    return () => window.removeEventListener("mousedown", closeMenuOnOutsidePointer, true);
  }, [closeHomeMenus]);

  return {
    announcementOpen,
    archiveFailed,
    archiveProjectTarget,
    closeHomeMenus,
    closeHomeModelMenu,
    closeNewsletter,
    communicationPreferences,
    communicationPreferencesBusy,
    confirmArchiveProject,
    dismissAnnouncement,
    duplicateProject,
    homeModel,
    homeModelMenuOpen,
    homeMoreMenuOpen,
    homeStyleMenuOpen,
    mobileProjectsOpen,
    newsletterOpen,
    onArchiveDialogOpenChange,
    openNewsletter,
    projectActionBusy,
    requestArchiveProject,
    saveCommunicationPreferences,
    selectHomeModel,
    toggleHomeModelMenu,
    toggleHomeMoreMenu,
    toggleHomeStyleMenu,
    toggleMobileProjects,
  };
}
