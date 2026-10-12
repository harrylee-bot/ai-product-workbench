package com.apitable.organization.controller;

import static com.apitable.core.constants.RedisConstants.ERROR_PWD_NUM_DIR;

import com.apitable.base.service.impl.ParamVerificationServiceImpl;
import com.apitable.control.infrastructure.permission.space.resource.ResourceCode;
import com.apitable.core.exception.BusinessException;
import com.apitable.organization.controller.CommunityMemberPasswordController.PasswordResetRequest;
import com.apitable.organization.entity.MemberEntity;
import com.apitable.organization.service.IMemberService;
import com.apitable.shared.component.scanner.annotation.GetResource;
import com.apitable.shared.component.scanner.annotation.PostResource;
import com.apitable.shared.holder.UserHolder;
import com.apitable.shared.security.PasswordServiceImpl;
import com.apitable.space.entity.SpaceEntity;
import com.apitable.space.mapper.SpaceMemberRoleRelMapper;
import com.apitable.space.mapper.SpaceResourceMapper;
import com.apitable.space.service.ISpaceService;
import com.apitable.user.entity.UserEntity;
import com.apitable.user.service.IUserService;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

/** Executable behavior tests; uses the image's own libraries, with no database or network. */
public final class CommunityMemberPasswordControllerTest {
    private static int passed;

    public static void main(String[] args) throws Exception {
        scenario("main administrator resets an ordinary user", f -> {
            check(f.allowed(), "capability should be true");
            f.reset();
            check(f.events.equals(List.of("password:202", "sessions:202:false",
                "unlock:" + ERROR_PWD_NUM_DIR + "202")), "reset side effects/order");
            check(f.passwordService.matches(f.body.getPassword(), f.hashes.get(202L)),
                "new password authenticates");
            check(!f.passwordService.matches("Previous123", f.hashes.get(202L)),
                "old password no longer authenticates");
            check(!f.sessions.contains(202L), "all target sessions revoked");
            check(f.sessions.contains(101L), "administrator session retained");
        });
        scenario("main administrator resets a sub administrator", f -> {
            f.roles.add(22L); f.target().setIsAdmin(true); f.reset(); f.changed();
        });
        scenario("delegated member manager resets an ordinary user", f -> {
            f.delegate(); f.reset(); f.changed();
        });
        scenario("ordinary member denied", f -> { f.space().setOwner(99L); f.denied(); });
        scenario("sub administrator without member-edit permission denied", f -> {
            f.delegate(); f.codes.clear(); f.denied();
        });
        scenario("read-only member permission denied", f -> {
            f.delegate(); f.codes.clear(); f.codes.add(ResourceCode.READ_MEMBER.getCode()); f.denied();
        });
        scenario("stale administrator flag grants no authority", f -> {
            f.space().setOwner(99L); f.actor().setIsAdmin(true); f.denied();
        });
        scenario("permission without actual administrator role denied", f -> {
            f.delegate(); f.roles.remove(11L); f.denied();
        });
        scenario("member manager cannot reset another sub administrator", f -> {
            f.delegate(); f.roles.add(22L); f.denied();
        });
        scenario("member manager cannot reset a stale admin flag", f -> {
            f.delegate(); f.target().setIsAdmin(true); f.denied();
        });
        scenario("cannot reset current space owner", f -> { f.delegate(); f.space().setOwner(22L); f.denied(); });
        scenario("main administrator cannot reset self", f -> {
            f.body.setMemberId(11L); f.denied();
        });
        scenario("sub administrator cannot reset self", f -> {
            f.delegate(); f.body.setMemberId(11L); f.denied();
        });
        scenario("blank trusted space disables feature", f -> { f.set("trustedSpaceId", ""); f.denied(); });
        scenario("blank trusted origin disables feature", f -> { f.set("trustedOrigin", ""); f.denied(); });
        scenario("missing current space denied", f -> { f.headers.remove("X-Space-Id"); f.denied(); });
        scenario("untrusted self-created space denied", f -> {
            f.headers.put("X-Space-Id", "untrusted");
            f.spaces.put("untrusted", space("untrusted", 11L)); f.denied();
        });
        scenario("cross-space target denied", f -> { f.target().setSpaceId("other"); f.denied(); });
        scenario("nonexistent target denied", f -> { f.body.setMemberId(999L); f.denied(); });
        scenario("null target denied", f -> { f.body.setMemberId(null); f.denied(); });
        scenario("missing actor membership denied", f -> { f.members.remove(11L); f.denied(); });
        scenario("deleted actor membership denied", f -> { f.actor().setIsDeleted(true); f.denied(); });
        scenario("inactive actor denied", f -> { f.actor().setIsActive(false); f.denied(); });
        scenario("unactivated actor status denied", f -> { f.actor().setStatus(0); f.denied(); });
        scenario("deleted actor account denied", f -> { f.users.get(101L).setIsDeleted(true); f.denied(); });
        scenario("deleted trusted space denied", f -> { f.space().setIsDeleted(true); f.denied(); });
        scenario("pending deletion of trusted space denied", f -> {
            f.space().setPreDeletionTime(LocalDateTime.now()); f.denied();
        });
        scenario("deleted target membership denied", f -> { f.target().setIsDeleted(true); f.denied(); });
        scenario("inactive target denied", f -> { f.target().setIsActive(false); f.denied(); });
        scenario("unactivated target status denied", f -> { f.target().setStatus(0); f.denied(); });
        scenario("pending deletion target denied", f -> { f.target().setStatus(2); f.denied(); });
        scenario("missing target user id denied", f -> { f.target().setUserId(null); f.denied(); });
        scenario("deleted target account denied", f -> { f.users.get(202L).setIsDeleted(true); f.denied(); });
        scenario("missing target account denied", f -> { f.users.remove(202L); f.denied(); });
        scenario("paused target account denied", f -> { f.users.get(202L).setIsPaused(true); f.denied(); });
        scenario("main administrator can recover a personal-space owner", f -> {
            f.otherMembership(true); f.reset(); f.changed();
        });
        scenario("member manager can recover a personal-space owner", f -> {
            f.delegate(); f.otherMembership(true); f.reset(); f.changed();
        });
        scenario("trusted recovery authority uses current space hierarchy", f -> {
            f.delegate(); f.otherMembership(false); f.roles.add(33L); f.reset(); f.changed();
        });
        scenario("inactive remote membership does not block recovery", f -> {
            f.delegate(); f.otherMembership(false); f.roles.add(33L);
            f.members.get(33L).setIsActive(false).setStatus(0); f.reset(); f.changed();
        });
        scenario("main administrator may reset remote sub administrator", f -> {
            f.otherMembership(false); f.roles.add(33L); f.reset(); f.changed();
        });
        scenario("pending-deletion personal space does not block recovery", f -> {
            f.otherMembership(true); f.spaces.get("other").setPreDeletionTime(LocalDateTime.now());
            f.reset(); f.changed();
        });
        scenario("permission revoked after capability is rechecked on mutation", f -> {
            f.delegate(); check(f.allowed(), "capability initially allowed");
            f.codes.clear(); f.rejected();
        });
        scenario("target promoted after capability is rechecked on mutation", f -> {
            f.delegate(); check(f.allowed(), "capability initially allowed");
            f.roles.add(22L); f.rejected();
        });
        scenario("mismatched passwords rejected", f -> { f.body.setConfirmPassword("Different123"); f.rejected(); });
        scenario("short password rejected", f -> { f.password("A123"); f.rejected(); });
        scenario("overlong password rejected", f -> { f.password("A1234567890123456789012345"); f.rejected(); });
        scenario("letters-only password rejected", f -> { f.password("Abcdefgh"); f.rejected(); });
        scenario("numbers-only password rejected", f -> { f.password("12345678"); f.rejected(); });
        scenario("blank password rejected", f -> { f.password(""); f.rejected(); });
        scenario("null password rejected", f -> { f.password(null); f.rejected(); });
        scenario("non-ASCII password rejected", f -> { f.password("Abcd1234中文"); f.rejected(); });
        scenario("minimum password length accepted", f -> { f.password("Abcd1234"); f.reset(); f.changed(); });
        scenario("maximum password length accepted", f -> { f.password("Abcd1234567890123456789!"); f.reset(); f.changed(); });
        scenario("missing origin and referer rejected", f -> { f.headers.remove("Origin"); f.rejected(); });
        scenario("cross-origin request rejected", f -> { f.headers.put("Origin", "https://attacker.example"); f.rejected(); });
        scenario("same-site alternate host rejected", f -> { f.headers.put("Origin", "https://other.aionbench.com"); f.rejected(); });
        scenario("origin suffix attack rejected", f -> { f.headers.put("Origin", "https://requirements.aionbench.com.attacker.example"); f.rejected(); });
        scenario("origin userinfo attack rejected", f -> { f.headers.put("Origin", "https://requirements.aionbench.com@attacker.example"); f.rejected(); });
        scenario("origin null rejected", f -> { f.headers.put("Origin", "null"); f.rejected(); });
        scenario("wrong scheme rejected", f -> { f.headers.put("Origin", "http://requirements.aionbench.com"); f.rejected(); });
        scenario("wrong port rejected", f -> { f.headers.put("Origin", "https://requirements.aionbench.com:8443"); f.rejected(); });
        scenario("invalid origin cannot fall back to valid referer", f -> {
            f.headers.put("Origin", "null"); f.headers.put("Referer", f.origin + "/management"); f.rejected();
        });
        scenario("same-origin referer fallback accepted", f -> {
            f.headers.remove("Origin"); f.headers.put("Referer", f.origin + "/management?tab=members");
            f.reset(); f.changed();
        });
        scenario("explicit default origin port accepted", f -> {
            f.headers.put("Origin", f.origin + ":443"); f.reset(); f.changed();
        });
        scenario("form content type rejected", f -> { f.contentType = "application/x-www-form-urlencoded"; f.rejected(); });
        scenario("text content type rejected", f -> { f.contentType = "text/plain"; f.rejected(); });
        scenario("missing content type rejected", f -> { f.contentType = null; f.rejected(); });
        scenario("JSON charset accepted", f -> { f.contentType = "application/json;charset=UTF-8"; f.reset(); f.changed(); });
        scenario("Authorization header cannot bypass origin guard", f -> {
            f.headers.put("Authorization", "Bearer test-only"); f.headers.remove("Origin"); f.rejected();
        });
        scenario("anonymous request denied", f -> { UserHolder.remove(); f.rejected(); });
        scenario("session revocation failure reports committed password change", f -> {
            f.revokeFails = true;
            try { f.reset(); throw new AssertionError("expected partial-success error"); }
            catch (BusinessException expected) {
                check(expected.getMessage().contains("密码已更新") && expected.getMessage().contains("旧会话"),
                    "must distinguish failed revocation from failed password update");
            }
            check(f.passwordService.matches(f.body.getPassword(), f.hashes.get(202L)), "password remains updated");
            check(f.events.equals(List.of("password:202", "sessions:202:false")), "revocation attempted after password update");
            f.revokeFails = false; f.reset(); check(!f.sessions.contains(202L), "retry revokes sessions");
        });
        scenario("unlock failure reports committed password and session changes", f -> {
            f.unlockFails = true;
            try { f.reset(); throw new AssertionError("expected partial-success error"); }
            catch (BusinessException expected) {
                check(expected.getMessage().contains("密码已更新且旧会话已退出"), "must report completed actions");
            }
            check(f.passwordService.matches(f.body.getPassword(), f.hashes.get(202L)), "password remains updated");
            check(!f.sessions.contains(202L), "sessions remain revoked");
        });
        scenario("password update failure does not revoke sessions", f -> {
            f.updateFails = true;
            try { f.reset(); throw new AssertionError("expected update error"); }
            catch (IllegalStateException expected) { /* Fake database failure. */ }
            check(f.events.equals(List.of("password:202")), "no post-update side effects on failure");
            check(f.passwordService.matches("Previous123", f.hashes.get(202L)), "old password retained on write failure");
            check(f.sessions.contains(202L), "sessions retained on write failure");
        });
        scenario("response and request toString do not expose password", f -> {
            try {
                String json = new ObjectMapper().writeValueAsString(f.controller.resetPassword(f.body, f.request()));
                check(!json.contains(f.body.getPassword()) && !json.contains("confirmPassword"), "response leaked password");
                check(!f.body.toString().contains(f.body.getPassword()), "request toString leaked password");
            } catch (Exception e) { throw new AssertionError(e); }
        });
        GetResource get = CommunityMemberPasswordController.class
            .getMethod("passwordResetCapability", Long.class, HttpServletRequest.class).getAnnotation(GetResource.class);
        PostResource post = CommunityMemberPasswordController.class
            .getMethod("resetPassword", PasswordResetRequest.class, HttpServletRequest.class).getAnnotation(PostResource.class);
        check(get.requiredLogin() && !get.requiredPermission(), "GET must explicitly require login with manual authorization");
        check(post.requiredLogin() && !post.requiredPermission(), "POST must explicitly require login with manual authorization");
        check(CommunityMemberPasswordController.class
            .getMethod("resetPassword", PasswordResetRequest.class, HttpServletRequest.class)
            .getAnnotation(Transactional.class) == null, "controller must let updatePwd commit before revoking sessions");
        ExceptionHandler parseHandler = CommunityMemberPasswordController.class
            .getMethod("unreadablePasswordRequest").getAnnotation(ExceptionHandler.class);
        check(List.of(parseHandler.value()).contains(HttpMessageNotReadableException.class),
            "malformed JSON must bypass global exception logging");
        String parseError = new ObjectMapper().writeValueAsString(new CommunityMemberPasswordController().unreadablePasswordRequest());
        check(parseError.contains("请求格式不正确") && !parseError.contains("NewSecure123"), "safe parse failure response");
        System.out.println("PASS: " + passed + " password-reset behavior scenarios plus route, transaction and parse-handler checks");
    }

    private static void scenario(String name, Consumer<Fixture> action) {
        try {
            action.accept(new Fixture());
            passed++;
        } catch (Throwable error) {
            throw new AssertionError("Failed scenario: " + name, error);
        } finally {
            UserHolder.remove(); RequestContextHolder.resetRequestAttributes();
        }
    }

    private static void check(boolean value, String message) {
        if (!value) { throw new AssertionError(message); }
    }

    private static MemberEntity member(Long id, Long userId, String spaceId) {
        return new MemberEntity().setId(id).setUserId(userId).setSpaceId(spaceId)
            .setIsActive(true).setIsDeleted(false).setIsAdmin(false).setStatus(1);
    }

    private static SpaceEntity space(String id, Long owner) {
        return new SpaceEntity().setSpaceId(id).setOwner(owner).setIsDeleted(false);
    }

    @SuppressWarnings("unchecked")
    private static <T> T fake(Class<T> type, InvocationHandler handler) {
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] {type}, handler);
    }

    private static final class Fixture {
        final CommunityMemberPasswordController controller = new CommunityMemberPasswordController();
        final Map<Long, MemberEntity> members = new HashMap<>();
        final Map<Long, UserEntity> users = new HashMap<>();
        final Map<String, SpaceEntity> spaces = new HashMap<>();
        final Map<String, String> headers = new HashMap<>();
        final Set<Long> roles = new HashSet<>();
        final List<String> codes = new ArrayList<>();
        final List<String> events = new ArrayList<>();
        final Set<Long> sessions = new HashSet<>(List.of(101L, 202L));
        final Map<Long, String> hashes = new HashMap<>();
        final PasswordServiceImpl passwordService = new PasswordServiceImpl(new BCryptPasswordEncoder(4));
        final PasswordResetRequest body = new PasswordResetRequest();
        final String origin = "https://requirements.aionbench.com";
        String contentType = "application/json";
        boolean revokeFails;
        boolean unlockFails;
        boolean updateFails;

        Fixture() {
            UserHolder.init(); UserHolder.set(101L);
            members.put(11L, member(11L, 101L, "trusted"));
            members.put(22L, member(22L, 202L, "trusted"));
            users.put(101L, new UserEntity().setId(101L).setIsDeleted(false).setIsPaused(false));
            users.put(202L, new UserEntity().setId(202L).setIsDeleted(false).setIsPaused(false));
            spaces.put("trusted", CommunityMemberPasswordControllerTest.space("trusted", 11L));
            headers.put("X-Space-Id", "trusted"); headers.put("Origin", origin);
            body.setMemberId(22L); password("NewSecure123!");
            hashes.put(202L, passwordService.encode("Previous123"));
            set("trustedSpaceId", "trusted"); set("trustedOrigin", origin);
            set("memberService", fake(IMemberService.class, (proxy, method, args) -> {
                switch (method.getName()) {
                    case "getById": return members.get(args[0]);
                    case "getByUserIdAndSpaceId": return members.values().stream()
                        .filter(m -> java.util.Objects.equals(m.getUserId(), args[0]) && m.getSpaceId().equals(args[1]))
                        .findFirst().orElse(null);
                    case "getByUserId": return members.values().stream()
                        .filter(m -> java.util.Objects.equals(m.getUserId(), args[0])).toList();
                    default: throw new AssertionError("Unexpected member service call: " + method.getName());
                }
            }));
            set("spaceService", fake(ISpaceService.class, (proxy, method, args) -> {
                if (method.getName().equals("getBySpaceIdIgnoreDeleted")) { return spaces.get(args[0]); }
                throw new AssertionError("Unexpected space service call: " + method.getName());
            }));
            set("spaceMemberRoleRelMapper", fake(SpaceMemberRoleRelMapper.class, (proxy, method, args) -> {
                if (method.getName().equals("selectCountBySpaceIdAndMemberId")) { return roles.contains(args[1]) ? 1 : 0; }
                throw new AssertionError("Unexpected role mapper call: " + method.getName());
            }));
            set("spaceResourceMapper", fake(SpaceResourceMapper.class, (proxy, method, args) -> {
                if (method.getName().equals("selectResourceCodesByMemberId")) { return codes; }
                throw new AssertionError("Unexpected permission mapper call: " + method.getName());
            }));
            set("userService", fake(IUserService.class, (proxy, method, args) -> {
                switch (method.getName()) {
                    case "getById": return users.get(args[0]);
                    case "updatePwd":
                        events.add("password:" + args[0]);
                        if (updateFails) { throw new IllegalStateException("Fake database unavailable"); }
                        hashes.put((Long) args[0], passwordService.encode((String) args[1])); return null;
                    case "closeMultiSession":
                        events.add("sessions:" + args[0] + ":" + args[1]);
                        if (revokeFails) { throw new IllegalStateException("Fake session store unavailable"); }
                        sessions.remove(args[0]); return null;
                    default: throw new AssertionError("Unexpected user service call: " + method.getName());
                }
            }));
            set("verificationService", new ParamVerificationServiceImpl());
            set("redisTemplate", new RedisTemplate<String, Integer>() {
                @Override
                public Boolean delete(String key) {
                    events.add("unlock:" + key);
                    if (unlockFails) { throw new IllegalStateException("Fake lock store unavailable"); }
                    return true;
                }
            });
            RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request()));
        }

        MemberEntity actor() { return members.get(11L); }
        MemberEntity target() { return members.get(22L); }
        SpaceEntity space() { return spaces.get("trusted"); }
        void password(String value) { body.setPassword(value); body.setConfirmPassword(value); }
        void delegate() { space().setOwner(99L); roles.add(11L); codes.add(ResourceCode.UPDATE_MEMBER.getCode()); }
        void otherMembership(boolean owner) {
            members.put(33L, member(33L, 202L, "other")); spaces.put("other", CommunityMemberPasswordControllerTest.space("other", owner ? 33L : 98L));
        }
        boolean allowed() { return controller.passwordResetCapability(body.getMemberId(), request()).getData().get("allowed"); }
        void reset() { controller.resetPassword(body, request()); }
        void changed() { check(events.size() == 3, "expected password update, session revocation and unlock"); }
        void denied() { check(!allowed(), "capability must be false"); rejected(); }
        void rejected() {
            try { reset(); throw new AssertionError("expected rejection"); }
            catch (BusinessException expected) { check(events.isEmpty(), "rejected request caused mutation"); }
        }
        void set(String name, Object value) {
            try {
                Field field = CommunityMemberPasswordController.class.getDeclaredField(name);
                field.setAccessible(true); field.set(controller, value);
            } catch (ReflectiveOperationException e) { throw new AssertionError(e); }
        }
        HttpServletRequest request() {
            return fake(HttpServletRequest.class, (proxy, method, args) -> {
                switch (method.getName()) {
                    case "getHeader": return headers.get(args[0]);
                    case "getContentType": return contentType;
                    case "getSession": return null;
                    case "getContextPath": return "";
                    case "getRequestURI": return "/org/member/resetPassword";
                    default: throw new AssertionError("Unexpected request call: " + method.getName());
                }
            });
        }
    }
}
