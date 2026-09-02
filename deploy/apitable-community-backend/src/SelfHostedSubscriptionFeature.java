/*
 * APITable <https://github.com/apitable/apitable>
 * Copyright (C) 2022 APITable Ltd. <https://apitable.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

package com.apitable.interfaces.billing.model;

import com.apitable.interfaces.billing.model.SubscriptionFeatures.ConsumeFeatures.ArchivedRowsPerSheet;
import com.apitable.interfaces.billing.model.SubscriptionFeatures.ConsumeFeatures.CapacitySize;
import com.apitable.interfaces.billing.model.SubscriptionFeatures.ConsumeFeatures.FileNodeNums;
import com.apitable.interfaces.billing.model.SubscriptionFeatures.ConsumeFeatures.RowsPerSheet;
import com.apitable.interfaces.billing.model.SubscriptionFeatures.ConsumeFeatures.Seat;
import com.apitable.interfaces.billing.model.SubscriptionFeatures.ConsumeFeatures.TotalRows;
import com.apitable.interfaces.billing.model.SubscriptionFeatures.SubscribeFeatures.AllowApplyJoin;
import com.apitable.interfaces.billing.model.SubscriptionFeatures.SubscribeFeatures.AllowInvitation;
import com.apitable.interfaces.billing.model.SubscriptionFeatures.SubscribeFeatures.AllowShare;

/** Self-hosted Community Edition defaults for unrestricted collaboration. */
public class SelfHostedSubscriptionFeature extends DefaultSubscriptionFeature {

    private static final long ATTACHMENT_CAPACITY_BYTES = 30L * 1024 * 1024 * 1024;

    @Override
    public Seat getSeat() {
        // The upstream CE seat check compares the raw value before checking the
        // unlimited flag on one invitation path. Use an unreachable ceiling so
        // every invitation path behaves as unrestricted.
        return Seat.unlimited(Long.MAX_VALUE);
    }

    @Override
    public CapacitySize getCapacitySize() {
        return new CapacitySize(ATTACHMENT_CAPACITY_BYTES);
    }

    @Override
    public FileNodeNums getFileNodeNums() {
        return new FileNodeNums(-1L);
    }

    @Override
    public RowsPerSheet getRowsPerSheet() {
        return new RowsPerSheet(-1L);
    }

    @Override
    public ArchivedRowsPerSheet getArchivedRowsPerSheet() {
        return new ArchivedRowsPerSheet(-1L);
    }

    @Override
    public TotalRows getTotalRows() {
        return new TotalRows(-1L);
    }

    @Override
    public AllowInvitation getAllowInvitation() {
        return new AllowInvitation(true);
    }

    @Override
    public AllowApplyJoin getAllowApplyJoin() {
        return new AllowApplyJoin(true);
    }

    @Override
    public AllowShare getAllowShare() {
        return new AllowShare(true);
    }
}
