/*
 * APITable <https://github.com/apitable/apitable>
 * Copyright (C) 2022 APITable Ltd. <https://apitable.com>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Input } from 'antd';
import axios from 'axios';
import { FC, useEffect, useRef, useState } from 'react';
import { TextButton } from '@apitable/components';
import { getLanguage, IMemberInfoInAddressList } from '@apitable/core';
// eslint-disable-next-line no-restricted-imports
import { Message, Modal } from 'pc/components/common';
import { useAppSelector } from 'pc/store/react-redux';
import styles from './style.module.less';

interface IResetTarget {
  contextKey: string;
  memberId: string;
  spaceId: string;
  name: string;
}

/** Password access is granted by the server for the selected member and space. */
export const MemberPasswordReset: FC<{ memberInfo: IMemberInfoInAddressList }> = ({ memberInfo }) => {
  const user = useAppSelector((state) => state.user.info);
  const spaceId = useAppSelector((state) => state.space.activeId);
  const isEnglish = getLanguage().startsWith('en');
  const contextKey = `${spaceId}:${memberInfo.memberId}:${user?.memberId || ''}`;
  const eligible = Boolean(
    spaceId && memberInfo.memberId && memberInfo.isActive && user &&
    (user.isMainAdmin || user.isAdmin) && memberInfo.memberId !== user.memberId &&
    !memberInfo.isPrimary && !memberInfo.isMainAdmin &&
    (user.isMainAdmin || (!memberInfo.isSubAdmin && !memberInfo.isAdmin)),
  );
  const [allowedContext, setAllowedContext] = useState('');
  const [target, setTarget] = useState<IResetTarget>();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [resetting, setResetting] = useState(false);
  const submitting = useRef(false);
  const contextVersion = useRef(0);

  const clearForm = () => {
    setTarget(undefined);
    setPassword('');
    setConfirmPassword('');
    setError('');
  };

  useEffect(() => {
    let current = true;
    contextVersion.current += 1;
    setAllowedContext('');
    clearForm();
    if (eligible) {
      axios.get('/org/member/passwordResetCapability', {
        params: { memberId: memberInfo.memberId },
        headers: { 'X-Space-Id': spaceId },
        timeout: 15000,
      }).then(({ data }) => {
        if (current && data.success && data.data?.allowed === true) {
          setAllowedContext(contextKey);
        }
      }).catch(() => {
        // Keep the action hidden when the server cannot confirm permission.
      });
    }
    return () => {
      current = false;
      contextVersion.current += 1;
    };
    // Member/space changes invalidate both the form and outstanding permission checks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextKey, eligible, user?.isMainAdmin, user?.isAdmin]);

  const allowed = eligible && allowedContext === contextKey;
  const visible = Boolean(allowed && target?.contextKey === contextKey);
  const passwordHint = isEnglish
    ? 'Use 8–24 characters with both English letters and numbers; supported symbols are optional.'
    : '密码为 8–24 位，须同时包含英文字母和数字，可使用支持的符号。';

  const submit = async () => {
    if (!visible || !target || submitting.current) return;
    if (!/^[`~!@#$%^&*()\-=+[{\]}|;:'",<.>/?\w]{8,24}$/.test(password) || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
      setError(passwordHint);
      return;
    }
    if (password !== confirmPassword) {
      setError(isEnglish ? 'The passwords do not match.' : '两次输入的密码不一致。');
      return;
    }
    const version = contextVersion.current;
    submitting.current = true;
    setResetting(true);
    setError('');
    try {
      const { data } = await axios.post('/org/member/resetPassword', {
        memberId: target.memberId,
        password,
        confirmPassword,
      }, { headers: { 'X-Space-Id': target.spaceId }, timeout: 15000 });
      if (version !== contextVersion.current) return;
      if (!data.success) {
        setError(data.message || (isEnglish ? 'Password reset failed. Please try again.' : '密码重置失败，请重试。'));
        return;
      }
      clearForm();
      Message.success({ content: isEnglish ? 'Password reset. The member must sign in again.' : '密码已重置，该成员需重新登录。' });
    } catch {
      if (version === contextVersion.current) {
        setError(isEnglish ? 'Could not confirm the reset. Please check the connection and try again.' : '暂时无法确认重置结果，请检查网络后重试。');
      }
    } finally {
      submitting.current = false;
      setResetting(false);
    }
  };

  if (!allowed) return null;

  return (
    <>
      <div className={styles.infoItem}>
        <span className={styles.infoTitle}>{isEnglish ? 'Account password' : '账户密码'}</span>
        <span className={styles.infoDetail}>
          <TextButton color="primary" size="small" disabled={resetting} onClick={() => {
            if (!spaceId) return;
            setPassword('');
            setConfirmPassword('');
            setError('');
            setTarget({ contextKey, memberId: memberInfo.memberId, spaceId, name: memberInfo.memberName || memberInfo.nickName || memberInfo.email });
          }}>
            {isEnglish ? 'Reset password' : '重置密码'}
          </TextButton>
        </span>
      </div>
      <Modal
        visible={visible}
        title={isEnglish ? 'Reset member password' : '重置成员密码'}
        width={440}
        destroyOnClose
        maskClosable={false}
        closable={!resetting}
        keyboard={!resetting}
        confirmLoading={resetting}
        okText={isEnglish ? 'Reset password' : '确认重置'}
        cancelText={isEnglish ? 'Cancel' : '取消'}
        okButtonProps={{ disabled: !password || !confirmPassword }}
        cancelButtonProps={{ disabled: resetting }}
        onCancel={() => { if (!submitting.current) clearForm(); }}
        onOk={submit}
      >
        <div style={{ display: 'grid', gap: 16 }}>
          <div>{isEnglish ? `Member: ${target?.name || ''}` : `成员：${target?.name || ''}`}</div>
          <p style={{ margin: 0, color: 'var(--secondLevelText)' }}>
            {isEnglish
              ? 'The old password and existing sessions will stop working. This changes the account password for all spaces. Share the new password with the member so they can sign in again.'
              : '重置后，旧密码及已有登录会话将失效，并影响该账号在所有空间的登录。请将新密码告知该成员，供其重新登录。'}
          </p>
          <label htmlFor="member-reset-password">
            {isEnglish ? 'New password' : '新密码'}
            <Input.Password
              id="member-reset-password"
              autoComplete="new-password"
              autoFocus
              value={password}
              maxLength={24}
              disabled={resetting}
              onChange={(event) => { setPassword(event.target.value); setError(''); }}
              aria-describedby="member-reset-password-hint"
            />
          </label>
          <label htmlFor="member-reset-password-confirm">
            {isEnglish ? 'Confirm password' : '确认新密码'}
            <Input.Password
              id="member-reset-password-confirm"
              autoComplete="new-password"
              value={confirmPassword}
              maxLength={24}
              disabled={resetting}
              onChange={(event) => { setConfirmPassword(event.target.value); setError(''); }}
              onPressEnter={submit}
            />
          </label>
          <p id="member-reset-password-hint" style={{ margin: 0, color: 'var(--secondLevelText)' }}>{passwordHint}</p>
          {error && <p role="alert" style={{ margin: 0, color: 'var(--errorColor)' }}>{error}</p>}
        </div>
      </Modal>
    </>
  );
};
