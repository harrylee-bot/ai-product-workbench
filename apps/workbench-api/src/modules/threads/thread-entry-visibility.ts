import type { Prisma } from '@workbench/workbench-db';
/** Legacy/unscoped entries remain project-visible. Discussion entries are private. */
export function threadEntryVisibility(principalId:string):Prisma.ThreadEntryWhereInput {
 return {OR:[{audiencePrincipalId:null},{audiencePrincipalId:principalId}]};
}
