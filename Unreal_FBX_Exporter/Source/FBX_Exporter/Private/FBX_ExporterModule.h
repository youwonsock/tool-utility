#pragma once

#include "Modules/ModuleManager.h"

class FFBXExporterModule final : public IModuleInterface
{
public:
	virtual void StartupModule() override;
	virtual void ShutdownModule() override;

private:
	void RegisterMenus();
};
