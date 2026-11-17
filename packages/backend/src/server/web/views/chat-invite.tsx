/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import locales from 'i18n';
import { I18n } from '@/misc/i18n.js';
import type { CommonProps } from '@/server/web/views/_.js';
import { Layout } from '@/server/web/views/base.js';

/** 초대 링크의 공개 정보만 OG에 싣고 검색에 올리지 않는다 */
export function ChatInvitePage(props: CommonProps<{
	invite: { url: string; name: string; description: string; membersCount: number; iconUrl: string };
	language?: string;
}>) {
	const i18n = new I18n(locales[props.language ?? 'ja-JP'] ?? locales['ja-JP']);
	const members = i18n.t('nUsers', { n: props.invite.membersCount });
	const description = [props.invite.description, members].filter(Boolean).join('\n');

	function ogBlock() {
		return (
			<>
				<meta property="og:type" content="website" />
				<meta property="og:title" content={props.invite.name} />
				<meta property="og:description" content={description} />
				<meta property="og:url" content={props.invite.url} />
				<meta property="og:image" content={props.invite.iconUrl} />
				<meta property="twitter:card" content="summary" />
				<meta property="og:site_name" content={props.instanceName} />
			</>
		);
	}

	return (
		<Layout
			{...props}
			title={`${props.invite.name} | ${props.instanceName}`}
			desc={description}
			noindex={true}
			ogSlot={ogBlock()}
		>
		</Layout>
	);
}
