/**
 * APITable <https://github.com/apitable/apitable>
 * Copyright (C) 2022 APITable Ltd. <https://apitable.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

import { useMount } from 'ahooks';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { Space, useTheme } from '@apitable/components';
import { getLanguage, IReduxState, t, Strings } from '@apitable/core';
import { Logo } from 'pc/components/common';
import { useAppSelector } from 'pc/store/react-redux';
import { ActiveAppSumo } from './components/active_app_sumo';
import { ForgetPassword } from './components/forget_password';
import { GithubButton } from './components/github_button';
import { Login } from './components/login';
import { NavBar } from './components/nav_bar';
import { SignUp } from './components/sign_up';
import { ActionType } from './pc_home';
import styles from './style.module.less';

export const MobileHome: React.FC<React.PropsWithChildren<unknown>> = () => {
  const inviteLinkInfo = useAppSelector((state: IReduxState) => state.invite.inviteLinkInfo);
  const inviteEmailInfo = useAppSelector((state: IReduxState) => state.invite.inviteEmailInfo);
  const [action, setAction] = useState<ActionType>(ActionType.SignUp);
  const [email, setEmail] = useState<string>('');
  const router = useRouter();
  const theme = useTheme().palette.type;

  const switchActionType = (actionType: ActionType) => {
    setAction(actionType);
  };
  const loginAction = localStorage.getItem('loginAction');
  useMount(() => {
    if (router.asPath.includes('sumo')) {
      setAction(ActionType.BindAppSumo);
      return;
    }
    if (loginAction === ActionType.SignIn) {
      setAction(ActionType.SignIn);
      localStorage.removeItem('loginAction');
    }
  });

  const homeModal = (action: ActionType) => {
    switch (action) {
      case ActionType.SignIn:
        return <Login switchClick={switchActionType} email={email} setEmail={setEmail} />;
        break;
      case ActionType.BindAppSumo:
        return <ActiveAppSumo />;
      case ActionType.SignUp:
        return <SignUp switchClick={switchActionType} />;
        break;
      case ActionType.ForgetPassword:
        return <ForgetPassword switchClick={switchActionType} email={email} setEmail={setEmail} />;
        break;
    }
  };

  const getTitle = (action: ActionType) => {
    const isEnglish = getLanguage() === 'en-US';
    switch (action) {
      case ActionType.SignIn:
        return isEnglish ? 'Sign In' : '登录';
        break;
      case ActionType.SignUp:
        return isEnglish ? 'Sign Up' : '注册';
        break;
      case ActionType.ForgetPassword:
        return isEnglish ? 'Reset Password' : '重置密码';
        break;
      case ActionType.BindAppSumo:
        return 'Welcome Sumo-ling!';
    }
  };

  return (
    <div className={styles.mobileHome}>
      <div className={styles.header}>
        <Logo theme={theme} size="large" />
      </div>
      {inviteLinkInfo || inviteEmailInfo ? (
        <div className={styles.invite}>
          <h4>
            {inviteLinkInfo?.data.memberName || inviteEmailInfo?.data.inviter} {t(Strings.invite_your_join)}
          </h4>
          <p>{`"${inviteLinkInfo?.data.spaceName || inviteEmailInfo?.data.spaceName}"`}</p>
        </div>
      ) : (
        <h3 className={styles.title}>{getTitle(action)}</h3>
      )}
      <div className={styles.content}>{homeModal(action)}</div>
      <Space size={41} vertical>
        <GithubButton />
        <NavBar action={action} />
      </Space>
    </div>
  );
};
