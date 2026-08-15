#include "FBX_ExporterModule.h"

#include "FBX_ExporterService.h"
#include "ToolMenus.h"

void FFBXExporterModule::StartupModule()
{
	UToolMenus::RegisterStartupCallback(
		FSimpleMulticastDelegate::FDelegate::CreateRaw(this, &FFBXExporterModule::RegisterMenus));
}

void FFBXExporterModule::ShutdownModule()
{
	UToolMenus::UnRegisterStartupCallback(this);
	UToolMenus::UnregisterOwner(this);
}

void FFBXExporterModule::RegisterMenus()
{
	FToolMenuOwnerScoped OwnerScoped(this);
	UToolMenu* ContentBrowserMenu = UToolMenus::Get()->ExtendMenu(TEXT("ContentBrowser.AssetContextMenu.AssetActionsSubMenu"));
	if (ContentBrowserMenu)
	{
		ContentBrowserMenu->AddDynamicSection(
			TEXT("FBX_Exporter"),
			FNewToolMenuDelegate::CreateStatic(&FBXExporter::PopulateContentBrowserMenu));
	}
}

IMPLEMENT_MODULE(FFBXExporterModule, FBX_Exporter)
