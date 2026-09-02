/**
 * APITable <https://github.com/apitable/apitable>
 * Copyright (C) 2022 APITable Ltd. <https://apitable.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import cls from 'classnames';
import { useEffect, useState } from 'react';
import { shallowEqual, useDispatch } from 'react-redux';
import { IOption, LinkButton, Skeleton, Typography } from '@apitable/components';
import { Api, INodeRoleMap, IReduxState, IUnitValue, StoreActions, Strings, t } from '@apitable/core';
import { ChevronRightOutlined, LinkOutlined, UserAddOutlined } from '@apitable/icons';
import { NodeChangeInfoType, useCatalogTreeRequest, useRequest } from 'pc/hooks';
import { useAppSelector } from 'pc/store/react-redux';
import { copy2clipBoard, permissionMenuData } from 'pc/utils';
import { Avatar, AvatarSize, Message, Tooltip } from '../../common';
import { UnitPermissionSelect } from '../../field_permission/unit_permission_select';
import { expandInviteModal } from '../../invite';
import { IMemberList } from '../permission_settings_plus/permission';
import { MembersDetail } from '../permission_settings_plus/permission/members_detail';
import { IShareContentProps } from './interface';
import styles from './style.module.less';

/** File-level collaboration backed by the self-hosted node-role controller. */
export const PermissionAndCollaborator: React.FC<IShareContentProps> = ({ data }) => {
  const [detailModalVisible, setDetailModalVisible] = useState(false);
  const [pageNo, setPageNo] = useState(1);
  const [memberList, setMemberList] = useState<IMemberList[]>([]);
  const socketData = useAppSelector((state) => state.catalogTree.socketData);
  const { getNodeRoleListReq, getCollaboratorListPageReq } = useCatalogTreeRequest();
  const { run: getNodeRoleList, data: roleList, loading } = useRequest<INodeRoleMap>(() => getNodeRoleListReq(data.nodeId));
  const { run: getCollaboratorReq, data: collaboratorInfo } = useRequest(
    (currentPageNo) => getCollaboratorListPageReq(currentPageNo, data.nodeId),
    { manual: true },
  );

  useEffect(() => {
    getCollaboratorReq(pageNo);
  }, [pageNo, getCollaboratorReq]);

  useEffect(() => {
    if (!collaboratorInfo) {
      return;
    }
    setMemberList((current) => {
      const members = pageNo === 1 ? collaboratorInfo.records : [...current, ...collaboratorInfo.records];
      return members.filter((member, index) => members.findIndex((item) => item.memberId === member.memberId) === index);
    });
  }, [collaboratorInfo, pageNo]);

  useEffect(() => {
    if (socketData?.type === NodeChangeInfoType.UpdateRole) {
      getNodeRoleList();
      getCollaboratorReq(1);
      setPageNo(1);
    }
  }, [socketData, getNodeRoleList, getCollaboratorReq]);

  const dispatch = useDispatch();
  const { spaceFeatures } = useAppSelector(
    (state: IReduxState) => ({ spaceFeatures: state.space.spaceFeatures }),
    shallowEqual,
  );

  const adminAndOwnerUnitIds = roleList
    ? [
      ...roleList.admins.map((value) => value.unitId),
      ...roleList.roleUnits.filter((value) => value.role === 'manager').map((value) => value.unitId),
      roleList.owner?.unitId || '',
    ]
    : [];

  const disableRoleExtend = async () => {
    if (!roleList?.extend) {
      return true;
    }
    const response = await Api.disableRoleExtend(data.nodeId, true);
    const { success, message } = response.data;
    if (!success) {
      Message.error({ content: message });
      return false;
    }
    dispatch(StoreActions.updateTreeNodesMap(data.nodeId, { nodePermitSet: true }));
    return true;
  };

  const onSubmit = async (unitInfos: IUnitValue[], permission: IOption) => {
    if (!unitInfos.length || !(await disableRoleExtend())) {
      return;
    }
    const unitIds = unitInfos.map((item) => item.unitId);
    const response = await Api.addRole(data.nodeId, unitIds, String(permission.value));
    const { success, message } = response.data;
    if (!success) {
      Message.error({ content: message });
      return;
    }
    Message.success({ content: t(Strings.permission_add_success) });
    await getNodeRoleList();
    getCollaboratorReq(1);
    setPageNo(1);
  };

  if (loading) {
    return (
      <div className={styles.invite}>
        <Skeleton count={1} style={{ marginTop: 0 }} width="25%" height="24px" />
        <Skeleton count={1} style={{ marginTop: '58px' }} height="24px" />
        <Skeleton count={1} style={{ marginTop: '16px' }} height="24px" />
      </div>
    );
  }

  return (
    <div className={styles.invite}>
      <Typography variant="h7" className={cls(styles.shareFloor, styles.shareTitle)}>
        <span>{t(Strings.collaborate_and_share)}</span>
      </Typography>

      <div className={styles.shareInvite}>
        <UnitPermissionSelect
          classNames={styles.permissionSelect}
          permissionList={permissionMenuData(data.type)}
          onSubmit={onSubmit}
          adminAndOwnerUnitIds={adminAndOwnerUnitIds}
          showTeams
          searchEmail
        />
      </div>

      <div className={cls(styles.shareFloor, styles.collaborator)}>
        <div className={styles.collaboratorStatus} onClick={() => setDetailModalVisible(true)}>
          {roleList && (
            <div className={styles.collaboratorIcon}>
              {memberList.slice(0, 5).map((member, index) => (
                <div
                  key={member.memberId}
                  className={styles.collaboratorIconItem}
                  style={{ marginLeft: index === 0 ? 0 : -16, zIndex: 5 - index }}
                >
                  <Tooltip title={member.memberName}>
                    <div>
                      <Avatar
                        src={member.avatar}
                        title={member.nickName || member.memberName}
                        avatarColor={member.avatarColor}
                        id={member.memberId}
                        size={AvatarSize.Size24}
                      />
                    </div>
                  </Tooltip>
                </div>
              ))}
            </div>
          )}
          <Typography variant="body3" className={styles.collaboratorNumber}>
            {t(Strings.collaborator_number, { number: collaboratorInfo?.total || 0 })}
          </Typography>
        </div>
        <Typography
          variant="body3"
          className={styles.collaboratorAuth}
          onClick={() => dispatch(StoreActions.updatePermissionModalNodeId(data.nodeId))}
        >
          <span>{t(Strings.setting_permission)}</span>
          <ChevronRightOutlined />
        </Typography>
      </div>

      <div className={styles.inviteMore}>
        <LinkButton
          className={styles.inviteMoreMethod}
          underline={false}
          onClick={() => copy2clipBoard(window.location.href)}
          prefixIcon={<LinkOutlined currentColor />}
        >
          {t(Strings.share_copy_url_link)}
        </LinkButton>
        {spaceFeatures?.invitable && (
          <LinkButton
            className={styles.inviteMoreMethod}
            underline={false}
            onClick={() => expandInviteModal()}
            prefixIcon={<UserAddOutlined currentColor />}
          >
            {t(Strings.more_invite_ways)}
          </LinkButton>
        )}
      </div>

      {detailModalVisible && (
        <MembersDetail
          data={collaboratorInfo}
          memberList={memberList}
          setPageNo={setPageNo}
          pageNo={pageNo}
          onCancel={() => setDetailModalVisible(false)}
        />
      )}
    </div>
  );
};
