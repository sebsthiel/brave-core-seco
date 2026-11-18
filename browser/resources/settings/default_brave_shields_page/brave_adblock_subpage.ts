/* Copyright (c) 2022 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import './components/brave_adblock_editor.js'
import './components/brave_adblock_scriptlet_list.js'
import './components/brave_adblock_subscribe_dropdown.js'
import 'chrome://resources/cr_elements/cr_dialog/cr_dialog.js'
import '//resources/cr_elements/md_select.css.js'

import {PrefService} from '/shared/settings/prefs2/pref_service.js'
import {PrefServiceObserverMixin} from '/shared/settings/prefs2/pref_service_observer_mixin.js'
import {I18nMixin} from 'chrome://resources/cr_elements/i18n_mixin.js'
import type {
  DomRepeatEvent
} from 'chrome://resources/polymer/v3_0/polymer/polymer_bundled.min.js'
import {
  PolymerElement
} from 'chrome://resources/polymer/v3_0/polymer/polymer_bundled.min.js'

import {BaseMixin} from '../base_mixin.js'

import {
  BraveAdblockBrowserProxy,
  BraveAdblockBrowserProxyImpl,
  FilterList,
  Scriptlet,
  SubscriptionInfo
} from './brave_adblock_browser_proxy.js'

import {SettingsViewMixin} from '../settings_page/settings_view_mixin.js';

import {getTemplate} from './brave_adblock_subpage.html.js'

import {loadTimeData} from '../i18n_setup.js'

const DEVELOPER_MODE_PREF = 'brave.ad_block.developer_mode'

interface CatalogAddon {
  title: string
  description: string
  author: string
  category: string
  rules: number
  scriptlets: number
  published: string
  updated: string
}

// TODO: Fetch add-ons from the catalog database instead of placeholder data.
const PLACEHOLDER_CATALOG_ADDONS: CatalogAddon[] = [
  {
    title: '[Add-on A]',
    description: '[Short description]',
    author: '@[nickname]',
    category: 'Annoyances',
    rules: 3,
    scriptlets: 2,
    published: '[date]',
    updated: '[date]',
  },
  {
    title: '[Add-on B]',
    description: '[Short description]',
    author: '@[nickname]',
    category: 'Cookie notices',
    rules: 12,
    scriptlets: 0,
    published: '[date]',
    updated: '[date]',
  },
  {
    title: '[Add-on C]',
    description: '[Short description]',
    author: '@[nickname]',
    category: 'Ads',
    rules: 0,
    scriptlets: 4,
    published: '[date]',
    updated: '[date]',
  },
]

const AdBlockSubpageBase = SettingsViewMixin(
  PrefServiceObserverMixin(I18nMixin(BaseMixin(PolymerElement))))

class AdBlockSubpage extends AdBlockSubpageBase {
  static get is() {
    return 'adblock-subpage'
  }

  static get template() {
    return getTemplate()
  }

  static get properties() {
    return {
      filterList_: Array,
      subscriptionList_: Array,
      customFilters_: String,
      subscribeUrl_: String,
      listsUpdatingState_: String,
      hasListExpanded_: {
        type: Boolean,
        value: false
      },
      shouldShowCustomFilters_: Boolean,
      shouldShowCustomScriptlets_: Boolean,
      customScriptlets_: Array,
      developerModePref_: Object,
      catalogEnabled_: {
        type: Boolean,
        value: false
      },
      showCatalogDialog_: {
        type: Boolean,
        value: false
      },
      catalogAddons_: {
        type: Array,
        value: () => PLACEHOLDER_CATALOG_ADDONS
      },
      catalogSearch_: {
        type: String,
        value: ''
      },
      catalogCategory_: {
        type: String,
        value: ''
      }
    }
  }

  static get observers() {
    return [
      'updateState_(developerModePref_.value, customFilters_, customScriptlets_)'
    ]
  }

  private declare filterList_: FilterList[]
  private declare subscriptionList_: SubscriptionInfo[]
  private declare customFilters_: string
  private declare subscribeUrl_: string
  private declare listsUpdatingState_: string
  private declare hasListExpanded_: boolean
  private declare shouldShowCustomFilters_: boolean
  private declare shouldShowCustomScriptlets_: boolean
  private declare customScriptlets_: Scriptlet[]
  private declare developerModePref_: chrome.settingsPrivate.PrefObject<boolean>
  // TODO: Persist the catalog on/off state in a pref.
  private declare catalogEnabled_: boolean
  private declare showCatalogDialog_: boolean
  private declare catalogAddons_: CatalogAddon[]
  private declare catalogSearch_: string
  private declare catalogCategory_: string

  private browserProxy_: BraveAdblockBrowserProxy =
    BraveAdblockBrowserProxyImpl.getInstance()

  override connectedCallback() {
    super.connectedCallback()

    this.mirrorPref(DEVELOPER_MODE_PREF, 'developerModePref_')
  }

  override ready() {
    super.ready()

    this.listsUpdatingState_ = ''

    this.browserProxy_.getRegionalLists().then(value => {
      this.filterList_ = value
    })

    this.browserProxy_.getListSubscriptions().then(value => {
      this.subscriptionList_ = value
    })

    this.browserProxy_.getCustomFilters().then(value => {
      this.customFilters_ = value
    })

    this.browserProxy_.getCustomScriptlets().then((value: Scriptlet[]) => {
      this.customScriptlets_ = value
    })

    this.browserProxy_.addWebUiListener(
      'brave_adblock.onGetListSubscriptions', (value: SubscriptionInfo[]) => {
        this.subscriptionList_ = value
    })
    this.browserProxy_.addWebUiListener(
      'brave_adblock.onCustomFiltersChanged',
      (value: string) => {
        this.customFilters_ = value
      }
    )
    this.browserProxy_.addWebUiListener(
      'brave_adblock.onCustomResourcesChanged',
      () => {
        this.browserProxy_.getCustomScriptlets().then((value: Scriptlet[]) => {
          this.customScriptlets_ = value
        })
      },
    )
  }

  private updateState_(
    devMode: boolean,
    customFilters: string,
    customScriptlets: Scriptlet[]
  ) {
    this.shouldShowCustomScriptlets_ =
      devMode !== undefined &&
      customScriptlets !== undefined &&
      (customScriptlets.length > 0 || devMode)

    this.shouldShowCustomFilters_ =
      devMode !== undefined &&
      customFilters !== undefined &&
      (customFilters.trim().length > 0 || devMode)
  }

  private handleTurnOnCatalog_() {
    this.showCatalogDialog_ = true
  }

  private handleCatalogDialogConfirm_() {
    this.catalogEnabled_ = true
    this.showCatalogDialog_ = false
  }

  private handleCatalogDialogCancel_() {
    this.showCatalogDialog_ = false
  }

  private handleCatalogLearnMore_() {
    // TODO: Link to the add-on catalog help page.
  }

  // The toggle is only shown while the catalog is on, so it only turns it off.
  // Turning on always goes through the confirmation dialog.
  private handleCatalogToggle_(detail: {checked: boolean}) {
    if (!detail.checked) {
      this.catalogEnabled_ = false
    }
  }

  private getCatalogCategories_(addons: CatalogAddon[]) {
    return [...new Set(addons.map(addon => addon.category))].sort()
  }

  private filterCatalogAddons_(
    addons: CatalogAddon[], search: string, category: string) {
    const query = search.trim().toLowerCase()
    return addons.filter(addon =>
      (!category || addon.category === category) &&
      (!query || [addon.title, addon.author, addon.category]
        .some(field => field.toLowerCase().includes(query))))
  }

  private onCatalogSearchInput_(e: Event) {
    this.catalogSearch_ = (e.target as HTMLInputElement).value
  }

  private onCatalogCategoryChange_(e: Event) {
    this.catalogCategory_ = (e.target as HTMLSelectElement).value
  }

  private getAddonContents_(addon: CatalogAddon) {
    const parts = []
    if (addon.rules) {
      parts.push(`${addon.rules} ${addon.rules === 1 ? 'rule' : 'rules'}`)
    }
    if (addon.scriptlets) {
      parts.push(`${addon.scriptlets} ${
        addon.scriptlets === 1 ? 'scriptlet' : 'scriptlets'}`)
    }
    return parts.join(', ')
  }

  private addonNeedsDeveloperMode_(addon: CatalogAddon, devMode: boolean) {
    return addon.scriptlets > 0 && !devMode
  }

  private handleTurnOnDeveloperMode_(e: Event) {
    e.preventDefault()
    PrefService.getInstance().setPrefValue(DEVELOPER_MODE_PREF, true)
  }

  private handleDownloadAddon_(e: Event&{model: {item: CatalogAddon}}) {
    // TODO: Download the add-on from the catalog database.
    console.log('Download add-on clicked', e.model.item.title)
  }

  private handlePublishAddon_() {
    // TODO: Implement publishing an add-on.
    console.log('Publish new add-on clicked')
  }

  private handleShowList_() {
    if (!this.hasListExpanded_) {
      this.hasListExpanded_ = true
    }
  }

  private handleUpdateLists_() {
    if (this.listsUpdatingState_ === 'updating') {
      return
    }

    this.listsUpdatingState_ = 'updating'

    this.browserProxy_.updateFilterLists().then(() => {
      this.listsUpdatingState_ = 'updated'
    }, () => {
      this.listsUpdatingState_ = 'failed'
    })
  }

  private searchListBy_(title: string) {
    if (!title) {
      this.hasListExpanded_ = false
      return null
    }

    return (item: FilterList) => {
      this.hasListExpanded_ = true
      title = title.toLowerCase()
      return (item.title?.toLowerCase().includes(title) ||
              item.desc?.toLowerCase().includes(title))
    }
  }

  private handleFilterListItemToggle_(e: DomRepeatEvent<FilterList>) {
    const filterList = e.model.item
    this.browserProxy_.enableFilterList(filterList.uuid, filterList.enabled)
  }

  private handleSubscribeUrlItemItemToggle_(
    e: DomRepeatEvent<SubscriptionInfo>)
  {
    const subscriptionInfo = e.model.item
    this.browserProxy_.setSubscriptionEnabled(
      subscriptionInfo.subscription_url, subscriptionInfo.enabled)
  }

  private onKeyUp_(e: KeyboardEvent) {
    if (e.keyCode === 13) {
      this.handleSubmitUrl_()
    }
  }

  private handleSubmitUrl_() {
    const url = this.subscribeUrl_.trim()
    if (!url) return

    this.browserProxy_.addSubscription(url)
    this.subscribeUrl_ = ''
  }

  private handleSave_(e: CustomEvent) {
    const value = e.detail.value
    this.browserProxy_.updateCustomFilters(value)
  }

  private handleUpdateSubscription_(
    e: Event&{model: {item: SubscriptionInfo}})
  {
    this.browserProxy_.updateSubscription(e.model.item.subscription_url)
  }

  private handleDeleteSubscription_(
    e: Event&{model: {item: SubscriptionInfo}})
  {
    this.browserProxy_.deleteSubscription(e.model.item.subscription_url)
  }

  private handleViewSubscription_(
    e: Event&{model: {item: SubscriptionInfo}})
  {
    this.browserProxy_.viewSubscription(e.model.item.subscription_url)
  }

  private getStringHtml_(id: string, link: string) {
    return this.i18nAdvanced(id, { substitutions: [ link ]})
  }

  private isEqual_(lhs: unknown, rhs: unknown) {
    return lhs === rhs
  }

  private isFailedUpdate_(item: SubscriptionInfo) {
    return item.last_successful_update_attempt !== 0 &&
           item.last_successful_update_attempt !== item.last_update_attempt
  }

  private isLastAttemptFailed_(item: SubscriptionInfo) {
    return item.last_successful_update_attempt !== 0 &&
           item.last_successful_update_attempt === item.last_update_attempt
  }
}

customElements.define(AdBlockSubpage.is, AdBlockSubpage)
