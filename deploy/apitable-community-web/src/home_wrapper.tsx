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

import { Typography, useTheme, useThemeColors } from '@apitable/components';
import { getLanguage } from '@apitable/core';
import { Logo } from 'pc/components/common';
import { getEnvVariables } from 'pc/utils/env';
import { NavBar } from './components/nav_bar';
import { ActionType } from './pc_home';
import styles from './style.module.less';

interface IHomeWrapper {
  action?: ActionType
}

export const HomeWrapper: React.FC<React.PropsWithChildren<IHomeWrapper>> = ({ children, action }) => {
  const colors = useThemeColors();
  const theme = useTheme().palette.type;
  const defaultMotto = getLanguage() === 'en-US' ? 'Make product collaboration clear and efficient' : '让产品协作更清晰、更高效';

  return (
    <div className={styles.pcHome}>
      <div className={styles.header}>
        <div className={styles.brand}>
          <Logo theme={theme} size="large" />
          <Typography variant={'h7'} color={colors.textCommonSecondary} style={{ marginLeft: 12 }}>
            {getEnvVariables().IS_AITABLE
              ? 'Custom ChatGPT with Table in 1-Click'
              : getEnvVariables().LOGIN_MOTTO || defaultMotto}
          </Typography>
        </div>
      </div>
      <div className={styles.main}>{children}</div>
      <div className={styles.footer}>
        <NavBar action={action} />
      </div>
    </div>
  );
};
