/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
/* eslint-disable import/no-default-export */
import type { StoryObj } from '@storybook/vue3';
import MkVisibilityPicker from './MkVisibilityPicker.vue';

export const Default = {
	render(args) {
		return {
			components: { MkVisibilityPicker },
			setup() {
				return { args };
			},
			template: '<MkVisibilityPicker v-bind="args" />',
		};
	},
	args: {
		currentVisibility: 'public',
		isSilenced: false,
		noteVisibilityLimit: 'none',
	},
} satisfies StoryObj<typeof MkVisibilityPicker>;

export const HomeLimit = {
	...Default,
	args: { ...Default.args, currentVisibility: 'home', noteVisibilityLimit: 'home' },
} satisfies StoryObj<typeof MkVisibilityPicker>;

export const FollowersLimit = {
	...Default,
	args: { ...Default.args, currentVisibility: 'followers', noteVisibilityLimit: 'followers' },
} satisfies StoryObj<typeof MkVisibilityPicker>;

export const RoleLimit = {
	...Default,
	args: { ...Default.args, currentVisibility: 'home', isSilenced: true },
} satisfies StoryObj<typeof MkVisibilityPicker>;

export const DirectReply = {
	...Default,
	args: { ...Default.args, currentVisibility: 'specified', isReplyVisibilitySpecified: true },
} satisfies StoryObj<typeof MkVisibilityPicker>;
