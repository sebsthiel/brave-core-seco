/* Copyright (c) 2022 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "brave/browser/ui/webui/settings/brave_adblock_handler.h"

#include <string>
#include <utility>

#include "base/check.h"
#include "base/check_op.h"
#include "base/command_line.h"
#include "base/feature_list.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/json/values_util.h"
#include "base/time/time.h"
#include "base/values.h"
#include "brave/browser/brave_browser_process.h"
#include "brave/components/brave_adblock/resources/grit/brave_adblock_generated_map.h"
#include "brave/components/brave_shields/content/browser/ad_block_custom_filters_provider.h"
#include "brave/components/brave_shields/content/browser/ad_block_service.h"
#include "brave/components/brave_shields/core/browser/ad_block_component_service_manager.h"
#include "brave/components/brave_shields/core/browser/ad_block_custom_resource_provider.h"
#include "brave/components/brave_shields/core/common/features.h"
#include "brave/components/brave_shields/core/common/pref_names.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/singleton_tabs.h"
#include "content/public/browser/storage_partition.h"
#include "content/public/browser/web_ui.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/header_util.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "ui/base/l10n/time_format.h"
#include "url/gurl.h"

namespace {

// Test catalog server from brave-seco/addon-catalog. Override with
// --addon-catalog-url=<url>.
// TODO: Replace with the real catalog server URL.
constexpr char kDefaultCatalogUrl[] = "http://localhost:3000/addons";
constexpr char kCatalogUrlSwitch[] = "addon-catalog-url";
constexpr size_t kMaxCatalogBytes = 5 * 1024 * 1024;
constexpr base::TimeDelta kCatalogTimeout = base::Seconds(10);

constexpr auto kCatalogTrafficAnnotation =
    net::DefineNetworkTrafficAnnotation("brave_adblock_addon_catalog", R"(
      semantics {
        sender: "Brave Shields add-on catalog"
        description:
          "Downloads the whole catalog of user-made add-ons (filters and "
          "scriptlets) so the user can browse it in settings."
        trigger:
          "The user turns on the add-on catalog in Shields settings, or opens "
          "the content filters page while it is on."
        data:
          "No user data is sent. The server sees the user's IP address."
        destination: OTHER
      }
      policy {
        cookies_allowed: NO
        setting:
          "Turn the add-on catalog off in Shields content filter settings."
      }
    )");

constexpr auto kPublishTrafficAnnotation =
    net::DefineNetworkTrafficAnnotation("brave_adblock_addon_publish", R"(
      semantics {
        sender: "Brave Shields add-on catalog"
        description:
          "Publishes an add-on made of the user's selected custom filters and "
          "scriptlets to the public add-on catalog."
        trigger:
          "The user fills in the publish form in Shields settings and confirms."
        data:
          "The add-on title, description, category, author nickname, and the "
          "filter rules and scriptlets the user selected. The server sees the "
          "user's IP address."
        destination: OTHER
      }
      policy {
        cookies_allowed: NO
        setting:
          "Only sent when the user publishes an add-on."
      }
    )");

GURL GetCatalogUrl() {
  const auto* command_line = base::CommandLine::ForCurrentProcess();
  if (command_line->HasSwitch(kCatalogUrlSwitch)) {
    return GURL(command_line->GetSwitchValueASCII(kCatalogUrlSwitch));
  }
  return GURL(kDefaultCatalogUrl);
}

// Copies only the expected fields from the server's response, so the page
// never sees unexpected data. Returns nullopt if a required field is missing.
std::optional<base::DictValue> SanitizeCatalogAddon(const base::Value& value) {
  const base::DictValue* addon = value.GetIfDict();
  if (!addon) {
    return std::nullopt;
  }

  const std::optional<int> id = addon->FindInt("id");
  const std::string* title = addon->FindString("title");
  const std::string* author = addon->FindString("author");
  const std::string* category = addon->FindString("category");
  if (!id || !title || !author || !category) {
    return std::nullopt;
  }

  base::DictValue result;
  result.Set("id", *id);
  result.Set("title", *title);
  result.Set("author", *author);
  result.Set("category", *category);
  for (const char* key :
       {"description", "filters", "published_at", "updated_at"}) {
    const std::string* field = addon->FindString(key);
    result.Set(key, field ? *field : std::string());
  }
  result.Set("version", addon->FindInt("version").value_or(1));

  base::ListValue scriptlets;
  if (const base::ListValue* list = addon->FindList("scriptlets")) {
    for (const base::Value& item : *list) {
      const base::DictValue* scriptlet = item.GetIfDict();
      if (!scriptlet) {
        continue;
      }
      const std::string* name = scriptlet->FindString("name");
      const std::string* code = scriptlet->FindString("code");
      if (!name || !code) {
        continue;
      }
      scriptlets.Append(
          base::DictValue().Set("name", *name).Set("code", *code));
    }
  }
  result.Set("scriptlets", std::move(scriptlets));
  return result;
}

// Builds the publish request body from only the expected fields.
std::optional<base::DictValue> SanitizePublishRequest(
    const base::DictValue& addon) {
  base::DictValue result;
  for (const char* key :
       {"title", "author", "category", "description", "filters"}) {
    const std::string* field = addon.FindString(key);
    if (!field) {
      return std::nullopt;
    }
    result.Set(key, *field);
  }

  base::ListValue scriptlets;
  if (const base::ListValue* list = addon.FindList("scriptlets")) {
    for (const base::Value& item : *list) {
      const base::DictValue* scriptlet = item.GetIfDict();
      const std::string* name = scriptlet ? scriptlet->FindString("name")
                                          : nullptr;
      const std::string* code = scriptlet ? scriptlet->FindString("code")
                                          : nullptr;
      if (!name || !code) {
        return std::nullopt;
      }
      scriptlets.Append(
          base::DictValue().Set("name", *name).Set("code", *code));
    }
  }
  result.Set("scriptlets", std::move(scriptlets));
  return result;
}

}  // namespace

BraveAdBlockHandler::BraveAdBlockHandler() = default;

BraveAdBlockHandler::~BraveAdBlockHandler() = default;

void BraveAdBlockHandler::RegisterMessages() {
  web_ui()->RegisterMessageCallback(
      "brave_adblock.getRegionalLists",
      base::BindRepeating(&BraveAdBlockHandler::GetRegionalLists,
                          base::Unretained(this)));

  web_ui()->RegisterMessageCallback(
      "brave_adblock.enableFilterList",
      base::BindRepeating(&BraveAdBlockHandler::EnableFilterList,
                          base::Unretained(this)));

  web_ui()->RegisterMessageCallback(
      "brave_adblock.updateFilterLists",
      base::BindRepeating(&BraveAdBlockHandler::UpdateFilterLists,
                          base::Unretained(this)));

  web_ui()->RegisterMessageCallback(
      "brave_adblock.getListSubscriptions",
      base::BindRepeating(&BraveAdBlockHandler::GetListSubscriptions,
                          base::Unretained(this)));

  web_ui()->RegisterMessageCallback(
      "brave_adblock.getCustomFilters",
      base::BindRepeating(&BraveAdBlockHandler::GetCustomFilters,
                          base::Unretained(this)));

  web_ui()->RegisterMessageCallback(
      "brave_adblock.addSubscription",
      base::BindRepeating(&BraveAdBlockHandler::AddSubscription,
                          base::Unretained(this)));

  web_ui()->RegisterMessageCallback(
      "brave_adblock.setSubscriptionEnabled",
      base::BindRepeating(&BraveAdBlockHandler::SetSubscriptionEnabled,
                          base::Unretained(this)));

  web_ui()->RegisterMessageCallback(
      "brave_adblock.updateSubscription",
      base::BindRepeating(&BraveAdBlockHandler::UpdateSubscription,
                          base::Unretained(this)));

  web_ui()->RegisterMessageCallback(
      "brave_adblock.deleteSubscription",
      base::BindRepeating(&BraveAdBlockHandler::DeleteSubscription,
                          base::Unretained(this)));

  web_ui()->RegisterMessageCallback(
      "brave_adblock.viewSubscription",
      base::BindRepeating(&BraveAdBlockHandler::ViewSubscriptionSource,
                          base::Unretained(this)));

  web_ui()->RegisterMessageCallback(
      "brave_adblock.updateCustomFilters",
      base::BindRepeating(&BraveAdBlockHandler::UpdateCustomFilters,
                          base::Unretained(this)));

  web_ui()->RegisterMessageCallback(
      "brave_adblock.getCustomScriptlets",
      base::BindRepeating(&BraveAdBlockHandler::GetCustomScriptlets,
                          base::Unretained(this)));

  web_ui()->RegisterMessageCallback(
      "brave_adblock.addCustomScriptlet",
      base::BindRepeating(&BraveAdBlockHandler::AddCustomScriptlet,
                          base::Unretained(this)));

  web_ui()->RegisterMessageCallback(
      "brave_adblock.updateCustomScriptlet",
      base::BindRepeating(&BraveAdBlockHandler::UpdateCustomScriptlet,
                          base::Unretained(this)));

  web_ui()->RegisterMessageCallback(
      "brave_adblock.removeCustomScriptlet",
      base::BindRepeating(&BraveAdBlockHandler::RemoveCustomScriptlet,
                          base::Unretained(this)));

  web_ui()->RegisterMessageCallback(
      "brave_adblock.getCatalogAddons",
      base::BindRepeating(&BraveAdBlockHandler::GetCatalogAddons,
                          base::Unretained(this)));

  web_ui()->RegisterMessageCallback(
      "brave_adblock.publishCatalogAddon",
      base::BindRepeating(&BraveAdBlockHandler::PublishCatalogAddon,
                          base::Unretained(this)));
  pref_change_registrar_.Init(g_browser_process->local_state());
}

void BraveAdBlockHandler::OnJavascriptAllowed() {
  service_observer_.Observe(g_brave_browser_process->ad_block_service()
                                ->subscription_service_manager());
  custom_resources_observer_.Observe(
      g_brave_browser_process->ad_block_service()->custom_resource_provider());
  pref_change_registrar_.Add(
      brave_shields::prefs::kAdBlockCustomFilters,
      base::BindRepeating(&BraveAdBlockHandler::RefreshCustomFilters,
                          weak_factory_.GetWeakPtr()));
}

void BraveAdBlockHandler::OnJavascriptDisallowed() {
  service_observer_.Reset();
  custom_resources_observer_.Reset();
  pref_change_registrar_.RemoveAll();
}

void BraveAdBlockHandler::OnServiceUpdateEvent() {
  if (!IsJavascriptAllowed()) {
    return;
  }

  RefreshSubscriptionsList();
}

void BraveAdBlockHandler::OnCustomResourcesChanged() {
  if (!IsJavascriptAllowed()) {
    return;
  }
  FireWebUIListener("brave_adblock.onCustomResourcesChanged");
}

void BraveAdBlockHandler::GetRegionalLists(const base::ListValue& args) {
  AllowJavascript();
  auto regional_lists = g_brave_browser_process->ad_block_service()
                            ->component_service_manager()
                            ->GetRegionalLists();

  ResolveJavascriptCallback(args[0], regional_lists);
}

void BraveAdBlockHandler::EnableFilterList(const base::ListValue& args) {
  DCHECK_EQ(args.size(), 2U);

  if (!args[0].is_string() || !args[1].is_bool()) {
    return;
  }

  std::string uuid = args[0].GetString();
  bool enabled = args[1].GetBool();

  g_brave_browser_process->ad_block_service()
      ->component_service_manager()
      ->EnableFilterList(uuid, enabled);
}

void BraveAdBlockHandler::UpdateFilterLists(const base::ListValue& args) {
  AllowJavascript();

  DCHECK_EQ(args.size(), 1U);
  if (!args[0].is_string()) {
    return;
  }

  std::string callback_id = args[0].GetString();

  g_brave_browser_process->ad_block_service()
      ->component_service_manager()
      ->UpdateFilterLists(
          base::BindOnce(&BraveAdBlockHandler::OnFilterListsUpdated,
                         weak_factory_.GetWeakPtr(), std::move(callback_id)));
}

void BraveAdBlockHandler::GetListSubscriptions(const base::ListValue& args) {
  AllowJavascript();
  ResolveJavascriptCallback(args[0], GetSubscriptions());
}

void BraveAdBlockHandler::GetCustomFilters(const base::ListValue& args) {
  AllowJavascript();
  const std::string custom_filters = g_brave_browser_process->ad_block_service()
                                         ->custom_filters_provider()
                                         ->GetCustomFilters();

  ResolveJavascriptCallback(args[0], base::Value(custom_filters));
}

void BraveAdBlockHandler::AddSubscription(const base::ListValue& args) {
  DCHECK_EQ(args.size(), 1U);
  AllowJavascript();
  if (!args[0].is_string()) {
    return;
  }

  std::string subscription_url_string = args[0].GetString();
  const GURL subscription_url = GURL(subscription_url_string);

  if (!subscription_url.is_valid()) {
    return;
  }

  g_brave_browser_process->ad_block_service()
      ->subscription_service_manager()
      ->CreateSubscription(subscription_url);

  RefreshSubscriptionsList();
}

void BraveAdBlockHandler::SetSubscriptionEnabled(const base::ListValue& args) {
  DCHECK_EQ(args.size(), 2U);
  AllowJavascript();
  if (!args[0].is_string() || !args[1].is_bool()) {
    return;
  }

  std::string subscription_url_string = args[0].GetString();
  bool enabled = args[1].GetBool();
  const GURL subscription_url = GURL(subscription_url_string);
  if (!subscription_url.is_valid()) {
    return;
  }
  g_brave_browser_process->ad_block_service()
      ->subscription_service_manager()
      ->EnableSubscription(subscription_url, enabled);

  RefreshSubscriptionsList();
}

void BraveAdBlockHandler::UpdateSubscription(const base::ListValue& args) {
  DCHECK_EQ(args.size(), 1U);
  AllowJavascript();
  if (!args[0].is_string()) {
    return;
  }

  std::string subscription_url_string = args[0].GetString();
  const GURL subscription_url = GURL(subscription_url_string);

  if (!subscription_url.is_valid()) {
    return;
  }
  g_brave_browser_process->ad_block_service()
      ->subscription_service_manager()
      ->RefreshSubscription(subscription_url, true);
}

void BraveAdBlockHandler::DeleteSubscription(const base::ListValue& args) {
  DCHECK_EQ(args.size(), 1U);
  AllowJavascript();
  if (!args[0].is_string()) {
    return;
  }

  std::string subscription_url_string = args[0].GetString();
  const GURL subscription_url = GURL(subscription_url_string);
  if (!subscription_url.is_valid()) {
    return;
  }
  g_brave_browser_process->ad_block_service()
      ->subscription_service_manager()
      ->DeleteSubscription(subscription_url);

  RefreshSubscriptionsList();
}

void BraveAdBlockHandler::ViewSubscriptionSource(const base::ListValue& args) {
  DCHECK_EQ(args.size(), 1U);
  if (!args[0].is_string()) {
    return;
  }

  std::string subscription_url_string = args[0].GetString();
  const GURL subscription_url = GURL(subscription_url_string);
  if (!subscription_url.is_valid()) {
    return;
  }

  const GURL file_url = g_brave_browser_process->ad_block_service()
                            ->subscription_service_manager()
                            ->GetListTextFileUrl(subscription_url);

  auto* browser = GlobalBrowserCollection::GetInstance()->FindBrowserWithTab(
      web_ui()->GetWebContents());
  ShowSingletonTabOverwritingNTP(browser, file_url);
}

void BraveAdBlockHandler::UpdateCustomFilters(const base::ListValue& args) {
  if (!args[0].is_string()) {
    return;
  }

  std::string custom_filters = args[0].GetString();
  g_brave_browser_process->ad_block_service()
      ->custom_filters_provider()
      ->UpdateCustomFilters(custom_filters);
}

void BraveAdBlockHandler::GetCustomScriptlets(const base::ListValue& args) {
  CHECK(args.size() == 1u && args[0].is_string());

  g_brave_browser_process->ad_block_service()
      ->custom_resource_provider()
      ->GetCustomResources(
          base::BindOnce(&BraveAdBlockHandler::OnGetCustomScriptlets,
                         weak_factory_.GetWeakPtr(), args[0].GetString()));
}

void BraveAdBlockHandler::OnGetCustomScriptlets(const std::string& callback_id,
                                                base::Value custom_resources) {
  AllowJavascript();
  ResolveJavascriptCallback(callback_id, custom_resources);
}

void BraveAdBlockHandler::AddCustomScriptlet(const base::ListValue& args) {
  CHECK(args.size() == 2u && args[0].is_string() && args[1].is_dict());

  g_brave_browser_process->ad_block_service()
      ->custom_resource_provider()
      ->AddResource(
          Profile::FromWebUI(web_ui())->GetPrefs(), args[1],
          base::BindOnce(&BraveAdBlockHandler::OnScriptletUpdateStatus,
                         weak_factory_.GetWeakPtr(), args[0].GetString()));
}

void BraveAdBlockHandler::UpdateCustomScriptlet(const base::ListValue& args) {
  CHECK(args.size() == 3u && args[0].is_string() && args[1].is_string() &&
        args[2].is_dict());

  g_brave_browser_process->ad_block_service()
      ->custom_resource_provider()
      ->UpdateResource(
          Profile::FromWebUI(web_ui())->GetPrefs(), args[1].GetString(),
          args[2],
          base::BindOnce(&BraveAdBlockHandler::OnScriptletUpdateStatus,
                         weak_factory_.GetWeakPtr(), args[0].GetString()));
}

void BraveAdBlockHandler::RemoveCustomScriptlet(const base::ListValue& args) {
  CHECK(args.size() == 2u && args[0].is_string() && args[1].is_string());

  g_brave_browser_process->ad_block_service()
      ->custom_resource_provider()
      ->RemoveResource(
          Profile::FromWebUI(web_ui())->GetPrefs(), args[1].GetString(),
          base::BindOnce(&BraveAdBlockHandler::OnScriptletUpdateStatus,
                         weak_factory_.GetWeakPtr(), args[0].GetString()));
}

void BraveAdBlockHandler::OnScriptletUpdateStatus(
    const std::string& callback_id,
    brave_shields::AdBlockCustomResourceProvider::ErrorCode error_code) {
  AllowJavascript();
  ResolveJavascriptCallback(callback_id,
                            base::Value(static_cast<int>(error_code)));
}

void BraveAdBlockHandler::GetCatalogAddons(const base::ListValue& args) {
  CHECK(args.size() == 1u && args[0].is_string());
  AllowJavascript();

  auto request = std::make_unique<network::ResourceRequest>();
  request->url = GetCatalogUrl();
  request->method = "GET";
  request->credentials_mode = network::mojom::CredentialsMode::kOmit;
  request->referrer_policy = net::ReferrerPolicy::NO_REFERRER;

  auto url_loader = network::SimpleURLLoader::Create(
      std::move(request), kCatalogTrafficAnnotation);
  url_loader->SetTimeoutDuration(kCatalogTimeout);

  auto url_loader_factory = Profile::FromWebUI(web_ui())
                                ->GetDefaultStoragePartition()
                                ->GetURLLoaderFactoryForBrowserProcess();

  auto* url_loader_ptr = url_loader.get();
  url_loader_ptr->DownloadToString(
      url_loader_factory.get(),
      base::BindOnce(&BraveAdBlockHandler::OnCatalogAddonsDownloaded,
                     weak_factory_.GetWeakPtr(), args[0].GetString(),
                     std::move(url_loader)),
      kMaxCatalogBytes);
}

void BraveAdBlockHandler::OnCatalogAddonsDownloaded(
    std::string callback_id,
    std::unique_ptr<network::SimpleURLLoader> url_loader,
    std::optional<std::string> body) {
  if (!IsJavascriptAllowed()) {
    return;
  }

  const auto* response_info = url_loader->ResponseInfo();
  const bool succeeded = body && response_info && response_info->headers &&
                         network::IsSuccessfulStatus(
                             response_info->headers->response_code());
  std::optional<base::ListValue> json =
      succeeded ? base::JSONReader::ReadList(*body, base::JSON_PARSE_RFC)
                : std::nullopt;
  if (!json) {
    RejectJavascriptCallback(base::Value(callback_id), base::Value());
    return;
  }

  base::ListValue addons;
  for (const base::Value& item : *json) {
    if (auto addon = SanitizeCatalogAddon(item)) {
      addons.Append(std::move(*addon));
    }
  }
  ResolveJavascriptCallback(base::Value(callback_id), addons);
}

void BraveAdBlockHandler::PublishCatalogAddon(const base::ListValue& args) {
  CHECK(args.size() == 2u && args[0].is_string() && args[1].is_dict());
  AllowJavascript();

  const std::string callback_id = args[0].GetString();
  std::optional<base::DictValue> addon =
      SanitizePublishRequest(args[1].GetDict());
  std::optional<std::string> body =
      addon ? base::WriteJson(*addon) : std::nullopt;
  if (!body) {
    RejectJavascriptCallback(
        base::Value(callback_id),
        base::DictValue().Set("error", "Invalid add-on data"));
    return;
  }

  auto request = std::make_unique<network::ResourceRequest>();
  request->url = GetCatalogUrl();
  request->method = "POST";
  request->credentials_mode = network::mojom::CredentialsMode::kOmit;
  request->referrer_policy = net::ReferrerPolicy::NO_REFERRER;

  auto url_loader = network::SimpleURLLoader::Create(
      std::move(request), kPublishTrafficAnnotation);
  url_loader->AttachStringForUpload(*body, "application/json");
  url_loader->SetTimeoutDuration(kCatalogTimeout);
  // Read the body of 4xx responses too, so the server's error message (for
  // example "title already exists") can be shown to the user.
  url_loader->SetAllowHttpErrorResults(true);

  auto url_loader_factory = Profile::FromWebUI(web_ui())
                                ->GetDefaultStoragePartition()
                                ->GetURLLoaderFactoryForBrowserProcess();

  auto* url_loader_ptr = url_loader.get();
  url_loader_ptr->DownloadToString(
      url_loader_factory.get(),
      base::BindOnce(&BraveAdBlockHandler::OnCatalogAddonPublished,
                     weak_factory_.GetWeakPtr(), callback_id,
                     std::move(url_loader)),
      kMaxCatalogBytes);
}

void BraveAdBlockHandler::OnCatalogAddonPublished(
    std::string callback_id,
    std::unique_ptr<network::SimpleURLLoader> url_loader,
    std::optional<std::string> body) {
  if (!IsJavascriptAllowed()) {
    return;
  }

  const auto* response_info = url_loader->ResponseInfo();
  const int response_code = response_info && response_info->headers
                                ? response_info->headers->response_code()
                                : 0;
  std::optional<base::DictValue> json =
      body ? base::JSONReader::ReadDict(*body, base::JSON_PARSE_RFC)
           : std::nullopt;

  if (network::IsSuccessfulStatus(response_code) && json) {
    if (auto addon = SanitizeCatalogAddon(base::Value(std::move(*json)))) {
      ResolveJavascriptCallback(base::Value(callback_id), *addon);
      return;
    }
  }

  const std::string* server_error = json ? json->FindString("error") : nullptr;
  RejectJavascriptCallback(
      base::Value(callback_id),
      base::DictValue()
          .Set("status", response_code)
          .Set("error", server_error ? *server_error
                                     : "Couldn't reach the catalog server"));
}

void BraveAdBlockHandler::RefreshSubscriptionsList() {
  FireWebUIListener("brave_adblock.onGetListSubscriptions", GetSubscriptions());
}

void BraveAdBlockHandler::RefreshCustomFilters() {
  const std::string& custom_filters =
      g_brave_browser_process->ad_block_service()
          ->custom_filters_provider()
          ->GetCustomFilters();
  FireWebUIListener("brave_adblock.onCustomFiltersChanged",
                    base::Value(custom_filters));
}

base::ListValue BraveAdBlockHandler::GetSubscriptions() {
  auto list_subscriptions = g_brave_browser_process->ad_block_service()
                                ->subscription_service_manager()
                                ->GetSubscriptions();

  base::ListValue list_value;
  base::Time now = base::Time::Now();

  for (const auto& subscription : list_subscriptions) {
    base::DictValue dict;

    base::TimeDelta relative_time_delta =
        now - subscription.last_successful_update_attempt;

    auto time_str = ui::TimeFormat::Simple(
        ui::TimeFormat::Format::FORMAT_ELAPSED,
        ui::TimeFormat::Length::LENGTH_LONG, relative_time_delta);

    dict.Set("subscription_url", subscription.subscription_url.spec());
    dict.Set("enabled", subscription.enabled);
    dict.Set("last_update_attempt",
             subscription.last_update_attempt.InMillisecondsFSinceUnixEpoch());
    dict.Set("last_successful_update_attempt",
             subscription.last_successful_update_attempt
                 .InMillisecondsFSinceUnixEpoch());
    dict.Set("last_updated_pretty_text", time_str);
    if (subscription.homepage) {
      dict.Set("homepage", *subscription.homepage);
    }
    if (subscription.title && !subscription.title->empty()) {
      dict.Set("title", *subscription.title);
    } else {
      dict.Set("title", subscription.subscription_url.spec());
    }

    list_value.Append(std::move(dict));
  }

  return list_value;
}

void BraveAdBlockHandler::OnFilterListsUpdated(std::string callback_id,
                                               bool success) {
  if (!IsJavascriptAllowed()) {
    return;
  }

  if (success) {
    ResolveJavascriptCallback(base::Value(callback_id), base::Value());
  } else {
    RejectJavascriptCallback(base::Value(callback_id), base::Value());
  }
}
