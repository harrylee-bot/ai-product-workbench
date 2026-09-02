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

import classnames from 'classnames';
import { ThemeName, useThemeColors } from '@apitable/components';
import { getLanguage } from '@apitable/core';

import styles from './styles.module.less';

const LogoSize = {
  mini: {
    logoSize: 16,
    logoTextHeight: 16,
  },
  small: {
    logoSize: 24,
    logoTextHeight: 24,
  },
  large: {
    logoSize: 32,
    logoTextHeight: 32,
  },
};

interface ILogoProps {
  className?: string;
  text?: boolean;
  size?: 'mini' | 'small' | 'large' | number;
  theme?: ThemeName;
  type?:'LOGO'|'SHARE_LOGO'
}

const isEnglish = getLanguage() === 'en-US';
const brandName = isEnglish ? 'Product Workbench' : '产品工作台';
const brandMark = isEnglish ? 'PW' : '产';

export const LogoText: React.FC<React.PropsWithChildren<React.SVGProps<SVGSVGElement>>> = ({ fill = 'currentColor', ...props }) => (
  <svg viewBox="0 0 180 32" aria-label={brandName} {...props}>
    <text x="0" y="23" fill={fill} fontSize="20" fontWeight="600">
      {brandName}
    </text>
  </svg>
);

export const Logo: React.FC<React.PropsWithChildren<ILogoProps>> = (props) => {
  const colors = useThemeColors();

  const { size = 'small', text = true, className, theme = ThemeName.Light } = props;
  const isLightTheme = theme === ThemeName.Light;
  const logoSize = typeof size === 'number' ? {
    logoSize: size,
    logoTextHeight: size,
  } : LogoSize[size];

  const color = isLightTheme ? colors.primaryColor : colors.staticWhite0;

  return (
    <span className={classnames(styles.logo, className)} aria-label={brandName} style={{ color }}>
      <span className={styles.brandMark} style={{ width: logoSize.logoSize, height: logoSize.logoSize, fontSize: logoSize.logoSize * 0.42 }}>
        {brandMark}
      </span>
      {text && (
        <span className={styles.brandName} style={{ height: logoSize.logoTextHeight, fontSize: logoSize.logoTextHeight * 0.68 }}>
          {brandName}
        </span>
      )}
    </span>
  );
};
