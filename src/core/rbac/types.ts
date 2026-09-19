/** the authenticated identity that RBAC decisions are made for (constructed by the authentication layer) */
export interface RbacSubject {
  id: string;
  roles: string[];
  /** team identifier for read:team scope; a subject currently has a single team */
  teamId?: string;
}
