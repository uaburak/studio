// Server data of Marka Kiti → Skill'ler: the brand's skills, a skill's versions, the running
// `brand.skill_draft` job ("AI ile çıkar") and the edits.
import {
  type BrandSkill,
  type BrandSkillCreate,
  type BrandSkillUpdate,
  type BrandSkillVersion,
  isTerminalJobStatus,
  type Job,
} from "@studio/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../lib/api.ts";
import { fetchAllPages } from "../../lib/paging.ts";
import { isHostUp, useHost, useJobs } from "../../state/studio.tsx";
import { useRefreshOnJobs } from "../job-refresh.ts";

export const skillKeys = {
  list: (brandId: string | null) => ["brand", "skills", brandId] as const,
  versions: (brandId: string | null, skillId: string | null) =>
    ["brand", "skill-versions", brandId, skillId] as const,
};

/** The brand's skills (oldest first); refreshed when an AI draft finishes. */
export function useBrandSkills(brandId: string | null) {
  const api = useApi();
  const up = isHostUp(useHost());
  useRefreshOnJobs(["brand.skill_draft"], brandId, [skillKeys.list(brandId)]);
  return useQuery({
    queryKey: skillKeys.list(brandId),
    queryFn: async (): Promise<BrandSkill[]> =>
      fetchAllPages(
        (cursor) =>
          api.brandSkills.list(brandId as string, { limit: 100, ...(cursor ? { cursor } : {}) }),
        2,
      ),
    enabled: up && brandId !== null,
    staleTime: 30_000,
  });
}

/** Every version of a skill, newest first. */
export function useSkillVersions(brandId: string | null, skillId: string | null) {
  const api = useApi();
  const up = isHostUp(useHost());
  return useQuery({
    queryKey: skillKeys.versions(brandId, skillId),
    queryFn: async (): Promise<BrandSkillVersion[]> =>
      fetchAllPages(
        (cursor) =>
          api.brandSkills.versions.list(brandId as string, skillId as string, {
            limit: 100,
            ...(cursor ? { cursor } : {}),
          }),
        5,
      ),
    enabled: up && brandId !== null && skillId !== null,
    staleTime: 30_000,
  });
}

/** The brand's `brand.skill_draft` jobs from the live feed (running one first). */
export function useSkillDraftJobs(brandId: string | null): { running: Job | null; all: Job[] } {
  const { jobs } = useJobs();
  const all = jobs.filter((j) => j.type === "brand.skill_draft" && j.brandId === brandId);
  return { running: all.find((j) => !isTerminalJobStatus(j.status)) ?? null, all };
}

export function useSkillActions(brandId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const put = (skill: BrandSkill) =>
    queryClient.setQueryData<BrandSkill[]>(skillKeys.list(brandId), (list) => {
      if (!list) return [skill];
      return list.some((s) => s.id === skill.id)
        ? list.map((s) => (s.id === skill.id ? skill : s))
        : [...list, skill];
    });
  const versionsChanged = (skillId: string) =>
    void queryClient.invalidateQueries({ queryKey: skillKeys.versions(brandId, skillId) });
  return {
    create: async (input: BrandSkillCreate) => {
      const skill = await api.brandSkills.create(brandId, input);
      put(skill);
      return skill;
    },
    update: async (skillId: string, input: BrandSkillUpdate) => {
      const skill = await api.brandSkills.update(brandId, skillId, input);
      put(skill);
      versionsChanged(skillId);
      return skill;
    },
    remove: async (skillId: string) => {
      await api.brandSkills.delete(brandId, skillId);
      queryClient.setQueryData<BrandSkill[]>(skillKeys.list(brandId), (list) =>
        list?.filter((s) => s.id !== skillId),
      );
    },
    restore: async (skillId: string, version: number) => {
      const skill = await api.brandSkills.versions.restore(brandId, skillId, version);
      put(skill);
      versionsChanged(skillId);
      return skill;
    },
    /** "AI ile çıkar": a `brand.skill_draft` job (the draft arrives switched off). */
    draft: (focus: string) =>
      api.jobs.create({
        type: "brand.skill_draft",
        brandId,
        payload: focus.trim() ? { focus: focus.trim() } : {},
      }),
  };
}
