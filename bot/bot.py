import asyncio
import json
import logging
import os
import time
from collections import defaultdict

import aiohttp
import discord
from discord.ext import tasks

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
TOKEN = os.environ.get('DISCORD_BOT_TOKEN', '')
SITE = os.environ.get('DIS_MANAGER_URL', '').rstrip('/')
if not TOKEN or not (SITE.startswith('https://') or SITE.startswith('http://127.0.0.1:')):
    raise SystemExit('DISCORD_BOT_TOKEN / DIS_MANAGER_URL を環境変数に設定してください。')


def emoji_key(value):
    if isinstance(value, discord.PartialEmoji):
        return str(value.id) if value.id else str(value.name).replace('\ufe0f', '')
    if value.startswith('<') and value.endswith('>'):
        return value.rsplit(':', 1)[-1][:-1]
    return value.replace('\ufe0f', '')


class RoleBot(discord.Client):
    def __init__(self):
        intents = discord.Intents.none()
        intents.guilds = True
        intents.guild_reactions = True
        super().__init__(intents=intents)
        self.panels = {}
        self.synced_at = 0
        self.locks = defaultdict(asyncio.Lock)

    async def setup_hook(self):
        self.http_session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15))
        self.sync_configs.start()

    async def close(self):
        self.sync_configs.cancel()
        await self.http_session.close()
        await super().close()

    @tasks.loop(seconds=15)
    async def sync_configs(self):
        try:
            async with self.http_session.get(
                SITE + '/api/bot/configs',
                headers={'Authorization': 'Bot ' + TOKEN},
                allow_redirects=False,
            ) as response:
                if response.status != 200:
                    logging.warning('設定同期に失敗しました (HTTP %s)。', response.status)
                    return
                data = await response.json()
            self.panels = {int(p['messageId']): p for p in data['panels']}
            self.synced_at = time.monotonic()
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, KeyError):
            logging.warning('設定を同期できませんでした。接続設定を確認してください。')

    @sync_configs.before_loop
    async def before_sync(self):
        await self.wait_until_ready()

    async def on_ready(self):
        logging.info('DIS-Manager Botが起動しました。')

    async def apply_reaction(self, payload, adding):
        if not payload.guild_id or (self.user and payload.user_id == self.user.id):
            return
        # Fail closed when configuration cannot be refreshed.
        if time.monotonic() - self.synced_at > 60:
            return
        async with self.locks[(payload.message_id, payload.user_id)]:
            panel = self.panels.get(payload.message_id)
            if not panel or str(payload.guild_id) != panel['guildId'] or str(payload.channel_id) != panel['channelId']:
                return
            if not adding and not panel['remove']:
                return
            mapping = next((r for r in panel['roles'] if emoji_key(r['emoji']) == emoji_key(payload.emoji)), None)
            if not mapping:
                return
            guild = self.get_guild(payload.guild_id)
            if not guild:
                return
            try:
                # Fetch rather than relying on member cache; privileged members intent is not needed.
                member = await guild.fetch_member(payload.user_id)
                if member.bot:
                    return
                role = guild.get_role(int(mapping['roleId']))
                if not role or not role.is_assignable():
                    logging.warning('付与できないロールです。Botのロール順序を確認してください。')
                    return
                if adding:
                    if panel['single']:
                        other_ids = {int(r['roleId']) for r in panel['roles'] if r['roleId'] != mapping['roleId']}
                        others = [r for r in member.roles if r.id in other_ids and r.is_assignable()]
                        if others:
                            await member.remove_roles(*others, reason='DIS-Manager: 単一選択')
                    await member.add_roles(role, reason='DIS-Manager: リアクション')
                    if panel['single']:
                        channel = guild.get_channel(payload.channel_id)
                        if channel:
                            message = await channel.fetch_message(payload.message_id)
                            for reaction in message.reactions:
                                if emoji_key(reaction.emoji) != emoji_key(payload.emoji) and any(emoji_key(r['emoji']) == emoji_key(reaction.emoji) for r in panel['roles']):
                                    await message.remove_reaction(reaction.emoji, member)
                else:
                    await member.remove_roles(role, reason='DIS-Manager: リアクション解除')
            except discord.NotFound:
                return
            except discord.Forbidden:
                logging.warning('Botのロール管理・メッセージ管理権限を確認してください。')
            except discord.HTTPException as error:
                logging.warning('Discordの操作に失敗しました (HTTP %s)。', error.status)

    async def on_raw_reaction_add(self, payload):
        await self.apply_reaction(payload, True)

    async def on_raw_reaction_remove(self, payload):
        await self.apply_reaction(payload, False)


if __name__ == '__main__':
    RoleBot().run(TOKEN, log_handler=None)

