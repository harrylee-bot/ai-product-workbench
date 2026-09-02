/*
 * APITable <https://github.com/apitable/apitable>
 * Copyright (C) 2022 APITable Ltd. <https://apitable.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

package com.apitable.workspace.controller;

import com.apitable.control.infrastructure.ControlTemplate;
import com.apitable.control.infrastructure.permission.NodePermission;
import com.apitable.control.infrastructure.role.ControlRoleManager;
import com.apitable.core.support.ResponseData;
import com.apitable.core.util.ExceptionUtil;
import com.apitable.organization.service.IOrganizationService;
import com.apitable.organization.vo.UnitMemberVo;
import com.apitable.shared.cache.service.UserSpaceCacheService;
import com.apitable.shared.component.scanner.annotation.ApiResource;
import com.apitable.shared.component.scanner.annotation.GetResource;
import com.apitable.shared.component.scanner.annotation.PostResource;
import com.apitable.shared.context.SessionContext;
import com.apitable.shared.holder.SpaceHolder;
import com.apitable.shared.util.page.PageInfo;
import com.apitable.shared.util.page.PageObjectParam;
import com.apitable.space.service.ISpaceRoleService;
import com.apitable.workspace.enums.PermissionException;
import com.apitable.workspace.ro.AddNodeRoleRo;
import com.apitable.workspace.ro.BatchDeleteNodeRoleRo;
import com.apitable.workspace.ro.BatchModifyNodeRoleRo;
import com.apitable.workspace.ro.DeleteNodeRoleRo;
import com.apitable.workspace.ro.ModifyNodeRoleRo;
import com.apitable.workspace.ro.RoleControlOpenRo;
import com.apitable.workspace.service.INodeRoleService;
import com.apitable.workspace.service.INodeService;
import com.apitable.workspace.vo.NodeCollaboratorsVo;
import com.apitable.workspace.vo.NodeRoleMemberVo;
import com.apitable.workspace.vo.NodeRoleUnit;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import jakarta.annotation.Resource;
import jakarta.validation.Valid;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Node collaborator APIs omitted from the upstream Community Edition controller set. */
@RestController
@ApiResource(path = "/node")
public class CommunityNodeRoleController {

    @Resource
    private INodeRoleService nodeRoleService;

    @Resource
    private INodeService nodeService;

    @Resource
    private ISpaceRoleService spaceRoleService;

    @Resource
    private IOrganizationService organizationService;

    @Resource
    private UserSpaceCacheService userSpaceCacheService;

    @Resource
    private ControlTemplate controlTemplate;

    /** Return the effective role assignment for a node. */
    @GetResource(path = "/listRole", requiredPermission = false)
    public ResponseData<NodeCollaboratorsVo> listRole(
        @RequestParam("nodeId") String nodeId,
        @RequestParam(value = "includeAdmin", required = false) Boolean includeAdmin,
        @RequestParam(value = "includeExtend", required = false) Boolean includeExtend,
        @RequestParam(value = "includeSelf", required = false) String includeSelf) {
        RequestContext context = checkPermission(nodeId, NodePermission.READ_NODE);
        boolean extend = !nodeRoleService.getNodeRoleIfEnabled(nodeId);
        String effectiveNodeId = extend ? nodeRoleService.getNodeExtendNodeId(nodeId) : nodeId;

        List<NodeRoleUnit> roleUnits;
        UnitMemberVo owner;
        String extendNodeName = null;
        if (effectiveNodeId == null) {
            roleUnits = Collections.singletonList(
                nodeRoleService.getRootNodeRoleUnit(context.spaceId));
            owner = null;
        } else {
            roleUnits = nodeRoleService.getNodeRoleUnitList(effectiveNodeId);
            owner = nodeRoleService.getNodeOwner(effectiveNodeId);
            if (extend) {
                extendNodeName = nodeService.getNodeNameByNodeId(effectiveNodeId);
            }
        }

        List<Long> adminMemberIds =
            spaceRoleService.getSpaceAdminsWithWorkbenchManage(context.spaceId);
        List<UnitMemberVo> admins = adminMemberIds.isEmpty()
            ? Collections.emptyList()
            : organizationService.findUnitMemberVo(adminMemberIds);
        if (!admins.isEmpty()) {
            nodeRoleService.handleNodeMemberTeamName(admins, context.spaceId);
        }

        List<UnitMemberVo> selfMembers =
            organizationService.findUnitMemberVo(Collections.singletonList(context.memberId));
        if (!selfMembers.isEmpty()) {
            nodeRoleService.handleNodeMemberTeamName(selfMembers, context.spaceId);
        }

        NodeCollaboratorsVo result = new NodeCollaboratorsVo();
        result.setExtend(extend);
        result.setAdmins(admins);
        result.setOwner(owner);
        result.setSelf(selfMembers.isEmpty() ? null : selfMembers.get(0));
        result.setRoleUnits(roleUnits);
        result.setMembers(Collections.emptyList());
        result.setExtendNodeName(extendNodeName);
        result.setBelongRootFolder(Objects.equals(
            nodeService.getParentIdByNodeId(nodeId),
            nodeService.getRootNodeIdBySpaceId(context.spaceId)));
        return ResponseData.success(result);
    }

    /** Return collaborators shown in the share and permission dialogs. */
    @GetResource(path = "/collaborator/page", requiredPermission = false)
    public ResponseData<PageInfo<NodeRoleMemberVo>> collaborators(
        @RequestParam("nodeId") String nodeId,
        @PageObjectParam Page<NodeRoleMemberVo> page) {
        checkPermission(nodeId, NodePermission.READ_NODE);
        return ResponseData.success(nodeRoleService.getNodeRoleMembersPageInfo(page, nodeId));
    }

    /**
     * Tell the public-share page whether the signed-in member can edit this node.
     * Anonymous visitors deliberately receive false so the public link remains read-only.
     */
    @GetResource(path = "/canEdit", requiredPermission = false)
    public ResponseData<Boolean> canEdit(@RequestParam("nodeId") String nodeId) {
        String spaceId = nodeService.getSpaceIdByNodeId(nodeId);
        SpaceHolder.set(spaceId);
        Long userId = SessionContext.getUserId();
        if (userId == null) {
            return ResponseData.success(false);
        }
        Long memberId = userSpaceCacheService.getMemberId(userId, spaceId);
        if (memberId == null) {
            return ResponseData.success(false);
        }
        return ResponseData.success(
            controlTemplate.hasNodePermission(memberId, nodeId, NodePermission.EDIT_NODE));
    }

    /** Switch from inherited permissions to explicit node permissions. */
    @PostResource(path = "/disableRoleExtend", requiredPermission = false)
    public ResponseData<Void> disableRoleExtend(
        @RequestParam("nodeId") String nodeId,
        @RequestBody(required = false) RoleControlOpenRo body) {
        RequestContext context = checkPermission(nodeId, NodePermission.ASSIGN_NODE_ROLE);
        if (!nodeRoleService.getNodeRoleIfEnabled(nodeId)) {
            boolean includeExtend = body != null && Boolean.TRUE.equals(body.getIncludeExtend());
            nodeRoleService.enableNodeRole(
                context.userId, context.spaceId, nodeId, includeExtend);
        }
        return ResponseData.success();
    }

    /** Switch back to inherited permissions. */
    @PostResource(path = "/enableRoleExtend", requiredPermission = false)
    public ResponseData<Void> enableRoleExtend(@RequestParam("nodeId") String nodeId) {
        RequestContext context = checkPermission(nodeId, NodePermission.ASSIGN_NODE_ROLE);
        if (nodeRoleService.getNodeRoleIfEnabled(nodeId)) {
            nodeRoleService.disableNodeRole(context.userId, nodeId);
        }
        return ResponseData.success();
    }

    /** Add one or more organization units to a node role. */
    @PostResource(path = "/addRole", requiredPermission = false)
    public ResponseData<Void> addRole(@RequestBody @Valid AddNodeRoleRo body) {
        RequestContext context =
            checkPermission(body.getNodeId(), NodePermission.ASSIGN_NODE_ROLE);
        ControlRoleManager.parseNodeRole(body.getRole());
        nodeRoleService.addNodeRole(
            context.userId, body.getNodeId(), body.getRole(), body.getUnitIds());
        return ResponseData.success();
    }

    /** Edit a single organization unit role. */
    @PostResource(path = "/editRole", requiredPermission = false)
    public ResponseData<Void> editRole(@RequestBody @Valid ModifyNodeRoleRo body) {
        RequestContext context =
            checkPermission(body.getNodeId(), NodePermission.ASSIGN_NODE_ROLE);
        ControlRoleManager.parseNodeRole(body.getRole());
        nodeRoleService.updateNodeRole(context.userId, body.getNodeId(), body.getRole(),
            Collections.singletonList(body.getUnitId()));
        return ResponseData.success();
    }

    /** Edit several organization unit roles. */
    @PostResource(path = "/batchEditRole", requiredPermission = false)
    public ResponseData<Void> batchEditRole(@RequestBody @Valid BatchModifyNodeRoleRo body) {
        RequestContext context =
            checkPermission(body.getNodeId(), NodePermission.ASSIGN_NODE_ROLE);
        ControlRoleManager.parseNodeRole(body.getRole());
        nodeRoleService.updateNodeRole(
            context.userId, body.getNodeId(), body.getRole(), body.getUnitIds());
        return ResponseData.success();
    }

    /** Remove a single organization unit from explicit node permissions. */
    @PostResource(path = "/deleteRole", method = RequestMethod.DELETE,
        requiredPermission = false)
    public ResponseData<Void> deleteRole(@RequestBody @Valid DeleteNodeRoleRo body) {
        RequestContext context =
            checkPermission(body.getNodeId(), NodePermission.ASSIGN_NODE_ROLE);
        nodeRoleService.deleteNodeRole(context.userId, body.getNodeId(), body.getUnitId());
        return ResponseData.success();
    }

    /** Remove several organization units from explicit node permissions. */
    @PostResource(path = "/batchDeleteRole", method = RequestMethod.DELETE,
        requiredPermission = false)
    public ResponseData<Void> batchDeleteRole(
        @RequestBody @Valid BatchDeleteNodeRoleRo body) {
        checkPermission(body.getNodeId(), NodePermission.ASSIGN_NODE_ROLE);
        nodeRoleService.deleteNodeRoles(body.getNodeId(), body.getUnitIds());
        return ResponseData.success();
    }

    private RequestContext checkPermission(String nodeId, NodePermission permission) {
        String spaceId = nodeService.getSpaceIdByNodeId(nodeId);
        SpaceHolder.set(spaceId);
        Long userId = SessionContext.getUserId();
        Long memberId = userSpaceCacheService.getMemberId(userId, spaceId);
        controlTemplate.checkNodePermission(memberId, nodeId, permission,
            status -> ExceptionUtil.isTrue(
                status, PermissionException.NODE_OPERATION_DENIED));
        return new RequestContext(userId, memberId, spaceId);
    }

    private static final class RequestContext {
        private final Long userId;
        private final Long memberId;
        private final String spaceId;

        private RequestContext(Long userId, Long memberId, String spaceId) {
            this.userId = userId;
            this.memberId = memberId;
            this.spaceId = spaceId;
        }
    }
}
