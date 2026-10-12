/*
 * APITable <https://github.com/apitable/apitable>
 * Copyright (C) 2022 APITable Ltd. <https://apitable.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

package com.apitable.organization.controller;

import static com.apitable.core.constants.RedisConstants.ERROR_PWD_NUM_DIR;

import com.apitable.auth.enums.AuthException;
import com.apitable.base.service.ParamVerificationService;
import com.apitable.control.infrastructure.permission.space.resource.ResourceCode;
import com.apitable.core.exception.BaseException;
import com.apitable.core.exception.BusinessException;
import com.apitable.core.support.ResponseData;
import com.apitable.organization.entity.MemberEntity;
import com.apitable.organization.service.IMemberService;
import com.apitable.shared.component.scanner.annotation.ApiResource;
import com.apitable.shared.component.scanner.annotation.GetResource;
import com.apitable.shared.component.scanner.annotation.PostResource;
import com.apitable.shared.constants.ParamsConstants;
import com.apitable.shared.context.SessionContext;
import com.apitable.space.entity.SpaceEntity;
import com.apitable.space.mapper.SpaceMemberRoleRelMapper;
import com.apitable.space.mapper.SpaceResourceMapper;
import com.apitable.space.service.ISpaceService;
import com.apitable.user.entity.UserEntity;
import com.apitable.user.service.IUserService;
import jakarta.annotation.Resource;
import jakarta.servlet.http.HttpServletRequest;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.http.MediaType;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Password administration for the deployment's explicitly trusted requirement-pool space. */
@RestController
@ApiResource(path = "/org/member")
public class CommunityMemberPasswordController {

    @Resource
    private IMemberService memberService;

    @Resource
    private ISpaceService spaceService;

    @Resource
    private SpaceMemberRoleRelMapper spaceMemberRoleRelMapper;

    @Resource
    private SpaceResourceMapper spaceResourceMapper;

    @Resource
    private IUserService userService;

    @Resource
    private ParamVerificationService verificationService;

    @Resource
    private RedisTemplate<String, Integer> redisTemplate;

    @Value("${WORKBENCH_PASSWORD_RESET_SPACE_ID:}")
    private String trustedSpaceId;

    @Value("${WORKBENCH_PASSWORD_RESET_ORIGIN:}")
    private String trustedOrigin;

    /** The UI uses the same current database authorization checks as the mutation. */
    @GetResource(path = "/passwordResetCapability", requiredLogin = true,
        requiredPermission = false)
    public ResponseData<Map<String, Boolean>> passwordResetCapability(
        @RequestParam("memberId") Long memberId, HttpServletRequest request) {
        return ResponseData.success(Collections.singletonMap("allowed",
            authorizedTarget(memberId, request) != null));
    }

    /** Reset a password, revoke all target sessions, and clear its password-attempt lock. */
    @PostResource(path = "/resetPassword", requiredLogin = true, requiredPermission = false)
    public ResponseData<Void> resetPassword(
        @RequestBody PasswordResetRequest body, HttpServletRequest request) {
        requireSameOriginJson(request);
        MemberEntity target = authorizedTarget(body == null ? null : body.getMemberId(), request);
        if (target == null) {
            throw new BusinessException(AuthException.FORBIDDEN);
        }
        // Do not use validation annotations or generated toString(): neither rejected password
        // values nor request bodies should appear in validation errors or application logs.
        verificationService.verifyPassword(body.getPassword());
        if (!Objects.equals(body.getPassword(), body.getConfirmPassword())) {
            throw new BusinessException(PasswordResetError.PASSWORD_MISMATCH);
        }
        Long userId = target.getUserId();
        // updatePwd owns its transaction and MUST commit before sessions are revoked. An
        // outer controller transaction would permit login with the old password in between.
        userService.updatePwd(userId, body.getPassword());
        try {
            userService.closeMultiSession(userId, false);
        } catch (RuntimeException ignored) {
            throw new BusinessException(PasswordResetError.SESSION_REVOKE_FAILED);
        }
        try {
            redisTemplate.delete(ERROR_PWD_NUM_DIR + userId);
        } catch (RuntimeException ignored) {
            throw new BusinessException(PasswordResetError.UNLOCK_FAILED);
        }
        return ResponseData.success();
    }

    /** Jackson errors may contain request literals; bypass the global exception logger. */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseData<Void> unreadablePasswordRequest() {
        return ResponseData.error(305, "请求格式不正确，请检查后重试");
    }

    private MemberEntity authorizedTarget(Long targetMemberId, HttpServletRequest request) {
        Long actorUserId = SessionContext.getUserId();
        String spaceId = request.getHeader(ParamsConstants.SPACE_ID);
        if (actorUserId == null || targetMemberId == null || trustedSpaceId == null
            || trustedSpaceId.isBlank() || !trustedSpaceId.trim().equals(spaceId)
            || origin(trustedOrigin, true) == null) {
            return null;
        }

        // Do not trust the client-provided space, cached roles, or a newly created space owner:
        // changing a password takes over an account across every space on this installation.
        SpaceEntity space = spaceService.getBySpaceIdIgnoreDeleted(spaceId);
        if (!liveSpace(space, spaceId) || space.getPreDeletionTime() != null
            || !liveUser(userService.getById(actorUserId))) {
            return null;
        }
        MemberEntity actor = memberService.getByUserIdAndSpaceId(actorUserId, spaceId);
        if (!activeMember(actor, spaceId) || !actorUserId.equals(actor.getUserId())) {
            return null;
        }
        boolean mainAdmin = Objects.equals(space.getOwner(), actor.getId());
        if (!mainAdmin) {
            if (!isSubAdmin(spaceId, actor.getId())) {
                return null;
            }
            List<String> codes = spaceResourceMapper.selectResourceCodesByMemberId(actor.getId());
            if (codes == null || !codes.contains(ResourceCode.UPDATE_MEMBER.getCode())) {
                return null;
            }
        }

        MemberEntity target = memberService.getById(targetMemberId);
        if (!activeMember(target, spaceId) || !targetMemberId.equals(target.getId())
            || actorUserId.equals(target.getUserId())
            || Objects.equals(space.getOwner(), target.getId())
            || !liveUser(userService.getById(target.getUserId()))) {
            return null;
        }

        // The configured space is the deployment's trusted account-recovery authority.
        // APITable automatically gives users personal spaces: owning another space must
        // not disable recovery. Hierarchy protection applies to this trusted space only;
        // the password and session changes intentionally affect the user's entire account.
        if (!mainAdmin && (Boolean.TRUE.equals(target.getIsAdmin())
            || isSubAdmin(spaceId, targetMemberId))) {
            return null;
        }
        return target;
    }

    private boolean isSubAdmin(String spaceId, Long memberId) {
        Integer count = spaceMemberRoleRelMapper.selectCountBySpaceIdAndMemberId(spaceId, memberId);
        return count != null && count > 0;
    }

    private static boolean activeMember(MemberEntity member, String spaceId) {
        return member != null && member.getId() != null && member.getUserId() != null
            && Objects.equals(spaceId, member.getSpaceId())
            && Boolean.FALSE.equals(member.getIsDeleted())
            && Boolean.TRUE.equals(member.getIsActive()) && Integer.valueOf(1).equals(member.getStatus());
    }

    private static boolean liveUser(UserEntity user) {
        return user != null && Boolean.FALSE.equals(user.getIsDeleted())
            && !Boolean.TRUE.equals(user.getIsPaused());
    }

    private static boolean liveSpace(SpaceEntity space, String spaceId) {
        return space != null && spaceId != null && Objects.equals(spaceId, space.getSpaceId())
            && Boolean.FALSE.equals(space.getIsDeleted()) && space.getOwner() != null;
    }

    private void requireSameOriginJson(HttpServletRequest request) {
        boolean json = false;
        try {
            MediaType contentType = MediaType.parseMediaType(request.getContentType());
            json = "application".equalsIgnoreCase(contentType.getType())
                && "json".equalsIgnoreCase(contentType.getSubtype());
        } catch (IllegalArgumentException ignored) {
            // Missing/invalid Content-Type is forbidden; never include the body in an error.
        }
        URI expected = origin(trustedOrigin, true);
        String suppliedOrigin = request.getHeader("Origin");
        URI supplied = suppliedOrigin == null
            ? origin(request.getHeader("Referer"), false) : origin(suppliedOrigin, true);
        if (!json || expected == null || !sameOrigin(expected, supplied)) {
            throw new BusinessException(AuthException.FORBIDDEN);
        }
    }

    private static URI origin(String value, boolean originOnly) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            URI uri = new URI(value.trim());
            if (!("https".equalsIgnoreCase(uri.getScheme()) || "http".equalsIgnoreCase(uri.getScheme()))
                || uri.getHost() == null || uri.getRawUserInfo() != null
                || (originOnly && (uri.getRawQuery() != null || uri.getRawFragment() != null
                    || !(uri.getRawPath() == null || uri.getRawPath().isEmpty()
                        || "/".equals(uri.getRawPath()))))) {
                return null;
            }
            return uri;
        } catch (URISyntaxException ignored) {
            return null;
        }
    }

    private static boolean sameOrigin(URI first, URI second) {
        return second != null && first.getScheme().equalsIgnoreCase(second.getScheme())
            && first.getHost().equalsIgnoreCase(second.getHost()) && port(first) == port(second);
    }

    private static int port(URI uri) {
        return uri.getPort() >= 0 ? uri.getPort() : "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }

    /** Explicit accessors intentionally omit toString() to avoid exposing the new password. */
    public static final class PasswordResetRequest {
        private Long memberId;
        private String password;
        private String confirmPassword;

        public Long getMemberId() { return memberId; }
        public void setMemberId(Long memberId) { this.memberId = memberId; }
        public String getPassword() { return password; }
        public void setPassword(String password) { this.password = password; }
        public String getConfirmPassword() { return confirmPassword; }
        public void setConfirmPassword(String confirmPassword) { this.confirmPassword = confirmPassword; }
    }

    private enum PasswordResetError implements BaseException {
        PASSWORD_MISMATCH("两次输入的密码不一致"),
        SESSION_REVOKE_FAILED("密码已更新，但未能确认旧会话退出，请再次重置后重试"),
        UNLOCK_FAILED("密码已更新且旧会话已退出，但未能清除登录错误锁定，请再次重置后重试");

        private final String message;

        PasswordResetError(String message) { this.message = message; }

        public Integer getCode() { return 305; }
        public String getMessage() { return message; }
    }
}
