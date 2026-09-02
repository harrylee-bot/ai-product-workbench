import fs from 'node:fs';
import path from 'node:path';

const brandStrings = {
  'en-US': {
    brand_desc: 'Product Workbench',
    apitable_og_product_description_content: 'Product Workbench is a collaborative workspace for product requirements and project data.',
    apitable_og_site_name_content: 'Product Workbench',
    og_product_description_content: 'Product Workbench is a collaborative workspace for product requirements and project data.',
    og_site_name_content: 'Product Workbench',
    client_meta_label_title: 'Product Workbench',
    client_meta_label_desc: 'Collaborative product requirements and project data workspace',
    system_configuration_company_name_short: 'Product Workbench',
    system_configuration_product_name: 'Product Workbench',
  },
  'zh-CN': {
    brand_desc: '产品工作台',
    apitable_og_product_description_content: '产品工作台是一套用于需求池和项目数据管理的多人协作工作台。',
    apitable_og_site_name_content: '产品工作台',
    og_product_description_content: '产品工作台是一套用于需求池和项目数据管理的多人协作工作台。',
    og_site_name_content: '产品工作台',
    client_meta_label_title: '产品工作台',
    client_meta_label_desc: '多人协作的产品需求与项目数据工作台',
    system_configuration_company_name_short: '产品工作台',
    system_configuration_product_name: '产品工作台',
  },
};

const replaceLegacyBrandNames = (value, brandName) =>
  typeof value === 'string'
    ? value
      .replaceAll('深圳维格云科技有限公司', brandName)
      .replaceAll('vika维格表', brandName)
      .replaceAll('Vika维格表', brandName)
      .replaceAll('维格云', brandName)
      .replaceAll('维格表', brandName)
      .replaceAll('APITable', brandName)
      .replaceAll('AITable', brandName)
      .replaceAll('Vika', brandName)
    : value;

const languageDirs = [
  path.resolve('packages/i18n-lang/src/config'),
  path.resolve('packages/datasheet/public/file/langs'),
];

for (const languageDir of languageDirs) {
  if (!fs.existsSync(languageDir)) {
    continue;
  }

  for (const [locale, overrides] of Object.entries(brandStrings)) {
    const localePath = path.join(languageDir, `strings.${locale}.json`);
    if (!fs.existsSync(localePath)) {
      continue;
    }
    const localeStrings = JSON.parse(fs.readFileSync(localePath, 'utf8'));
    for (const [key, value] of Object.entries(localeStrings)) {
      localeStrings[key] = replaceLegacyBrandNames(value, overrides.brand_desc);
    }
    Object.assign(localeStrings, overrides);
    fs.writeFileSync(localePath, `${JSON.stringify(localeStrings, null, 2)}\n`);
  }

  const mergedPath = path.join(languageDir, 'strings.json');
  if (!fs.existsSync(mergedPath)) {
    continue;
  }
  const mergedStrings = JSON.parse(fs.readFileSync(mergedPath, 'utf8'));
  for (const [locale, overrides] of Object.entries(brandStrings)) {
    for (const [key, value] of Object.entries(mergedStrings[locale])) {
      mergedStrings[locale][key] = replaceLegacyBrandNames(value, overrides.brand_desc);
    }
    Object.assign(mergedStrings[locale], overrides);
  }
  fs.writeFileSync(mergedPath, `${JSON.stringify(mergedStrings, null, 2)}\n`);
}

const replaceSourceText = (sourcePath, replacements) => {
  let source = fs.readFileSync(sourcePath, 'utf8');
  for (const [before, after] of replacements) {
    if (!source.includes(before)) {
      throw new Error(`Expected source text was not found in ${sourcePath}: ${before}`);
    }
    source = source.replace(before, after);
  }
  fs.writeFileSync(sourcePath, source);
};

replaceSourceText(path.resolve('packages/datasheet/src/pc/components/home/pc_home.tsx'), [
  [
    'import { IReduxState, Strings, t } from \'@apitable/core\';',
    'import { getLanguage, IReduxState, Strings, t } from \'@apitable/core\';',
  ],
  [
    '  const getTitle = (action: ActionType) => {\n    switch (action) {',
    "  const getTitle = (action: ActionType) => {\n    const isEnglish = getLanguage() === 'en-US';\n    switch (action) {",
  ],
  ["        return 'Sign In';", "        return isEnglish ? 'Sign In' : '登录';"],
  ["        return 'Sign Up';", "        return isEnglish ? 'Sign Up' : '注册';"],
  ["        return 'Reset Password';", "        return isEnglish ? 'Reset Password' : '重置密码';"],
]);

replaceSourceText(path.resolve('packages/datasheet/src/pc/components/home/components/sign_up/sign_up_base.tsx'), [
  ['              placeholder="Please enter your email address"', '              placeholder={t(Strings.email_placeholder)}'],
]);
